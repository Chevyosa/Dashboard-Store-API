import type { Pool } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import {
  countFailedLoginsForIp,
  countFailedLoginsForUser,
  insertAuditEntry,
} from '../repositories/audit.repository.js';
import {
  findSessionByTokenHash,
  insertSession,
  revokeSessionByTokenHash,
  touchSession,
} from '../repositories/session.repository.js';
import { findUserByUsername, touchLastLogin } from '../repositories/user.repository.js';
import { AppError } from '../utils/errors.js';
import { getDummyHash, verifyPassword } from '../utils/password.js';
import {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  TOUCH_INTERVAL_MS,
  realSleep,
  systemClock,
} from '../utils/time.js';
import type { Clock } from '../utils/time.js';
import { generateSessionToken, hashToken } from '../utils/token.js';

export interface AuthUser {
  id: number;
  username: string;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthServiceDeps {
  pool: Pool;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_FREE_FAILURES = 2;
const THROTTLE_BASE_MS = 500;
const THROTTLE_MAX_MS = 8000;

// 0 for the first two failures, then 0.5s doubling per failure, capped at 8s.
export function loginDelayMs(failures: number): number {
  if (failures <= THROTTLE_FREE_FAILURES) return 0;
  return Math.min(THROTTLE_BASE_MS * 2 ** (failures - THROTTLE_FREE_FAILURES - 1), THROTTLE_MAX_MS);
}

const INVALID_CREDENTIALS = (): AppError =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Username atau password salah.');

export function createAuthService({
  pool,
  clock = systemClock,
  sleep = realSleep,
}: AuthServiceDeps) {
  async function login(input: {
    username: string;
    password: string;
    previousToken: string | undefined;
    client: ClientInfo;
  }): Promise<{ token: string; user: AuthUser }> {
    const now = clock();
    const since = new Date(now.getTime() - THROTTLE_WINDOW_MS);
    const user = await findUserByUsername(pool, input.username);

    const [userFailures, ipFailures] = await Promise.all([
      user === null ? Promise.resolve(0) : countFailedLoginsForUser(pool, user.id, since),
      input.client.ip === null
        ? Promise.resolve(0)
        : countFailedLoginsForIp(pool, input.client.ip, since),
    ]);
    const delay = loginDelayMs(Math.max(userFailures, ipFailures));
    if (delay > 0) await sleep(delay);

    // Always run one argon2 verification, even for unknown users (constant-ish timing).
    const passwordOk = await verifyPassword(
      user === null ? await getDummyHash() : user.passwordHash,
      input.password,
    );

    if (user === null || !user.isActive || !passwordOk) {
      // The typed username is only stored when it belongs to a real user; people
      // often mistype their password into the username field.
      await insertAuditEntry(pool, {
        userId: user?.id ?? null,
        action: 'login_failed',
        ...(user === null ? { after: { reason: 'unknown_user' } } : {}),
        ip: input.client.ip,
        userAgent: input.client.userAgent,
        at: now,
      });
      throw INVALID_CREDENTIALS();
    }

    const token = generateSessionToken();
    await withTransaction(pool, async (conn) => {
      // Rotation: a session presented at login is revoked, never reused.
      if (input.previousToken !== undefined) {
        await revokeSessionByTokenHash(conn, hashToken(input.previousToken), now);
      }
      await insertSession(conn, {
        userId: user.id,
        tokenHash: hashToken(token),
        now,
        expiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS),
        ip: input.client.ip,
        userAgent: input.client.userAgent,
      });
      await touchLastLogin(conn, user.id, now);
      await insertAuditEntry(conn, {
        userId: user.id,
        action: 'login_success',
        ip: input.client.ip,
        userAgent: input.client.userAgent,
        at: now,
      });
    });

    return { token, user: { id: user.id, username: user.username } };
  }

  async function logout(token: string | undefined, client: ClientInfo): Promise<void> {
    if (token === undefined) return;
    const now = clock();
    const tokenHash = hashToken(token);
    const session = await findSessionByTokenHash(pool, tokenHash);
    const revoked = await revokeSessionByTokenHash(pool, tokenHash, now);
    if (session !== null && revoked) {
      await insertAuditEntry(pool, {
        userId: session.userId,
        action: 'logout',
        ip: client.ip,
        userAgent: client.userAgent,
        at: now,
      });
    }
  }

  // Returns the user for a valid session, or null (revoked, idle, expired, inactive).
  async function authenticate(token: string | undefined): Promise<AuthUser | null> {
    if (token === undefined) return null;
    const now = clock();
    const session = await findSessionByTokenHash(pool, hashToken(token));
    if (session === null || session.revokedAt !== null || !session.userIsActive) return null;
    if (now.getTime() >= session.expiresAt.getTime()) return null;
    if (now.getTime() - session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) return null;

    if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      await touchSession(pool, session.id, now);
    }
    return { id: session.userId, username: session.username };
  }

  return { login, logout, authenticate };
}

export type AuthService = ReturnType<typeof createAuthService>;
