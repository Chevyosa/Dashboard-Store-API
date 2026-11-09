import type { Pool } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import { revokeAllSessionsForUser } from '../repositories/session.repository.js';
import {
  findUserByUsername,
  insertUser,
  updateUserPassword,
} from '../repositories/user.repository.js';
import { AppError } from '../utils/errors.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from '../utils/password.js';
import { systemClock } from '../utils/time.js';
import type { Clock } from '../utils/time.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;

function assertValid(username: string, password: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Username harus 3-64 karakter: huruf, angka, titik, garis bawah, atau strip.',
    );
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Password minimal ${PASSWORD_MIN_LENGTH} karakter.`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Password maksimal ${PASSWORD_MAX_LENGTH} karakter.`,
    );
  }
}

export async function createAdmin(
  pool: Pool,
  input: { username: string; password: string },
  clock: Clock = systemClock,
): Promise<number> {
  assertValid(input.username, input.password);
  const passwordHash = await hashPassword(input.password);
  const now = clock();
  return withTransaction(pool, async (conn) => {
    if ((await findUserByUsername(conn, input.username)) !== null) {
      throw new AppError(409, 'USERNAME_TAKEN', 'Username sudah dipakai.');
    }
    const id = await insertUser(conn, { username: input.username, passwordHash, now });
    await insertAuditEntry(conn, {
      userId: id,
      action: 'admin_created',
      entityType: 'user',
      entityId: String(id),
      ip: null,
      userAgent: null,
      at: now,
    });
    return id;
  });
}

// Also revokes every session of that user: a forgotten/leaked password must lock out old logins.
export async function resetAdminPassword(
  pool: Pool,
  input: { username: string; password: string },
  clock: Clock = systemClock,
): Promise<void> {
  assertValid(input.username, input.password);
  const passwordHash = await hashPassword(input.password);
  const now = clock();
  await withTransaction(pool, async (conn) => {
    const user = await findUserByUsername(conn, input.username);
    if (user === null) throw new AppError(404, 'USER_NOT_FOUND', 'Username tidak ditemukan.');
    await updateUserPassword(conn, { id: user.id, passwordHash, now });
    await revokeAllSessionsForUser(conn, user.id, now);
    await insertAuditEntry(conn, {
      userId: user.id,
      action: 'admin_password_reset',
      entityType: 'user',
      entityId: String(user.id),
      ip: null,
      userAgent: null,
      at: now,
    });
  });
}
