import { createHash } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/app.js';
import { createAdmin } from '../../src/services/admin.service.js';
import { verifyPassword } from '../../src/utils/password.js';
import { cleanDatabase, createTestPool, getTestEnv } from '../helpers/db.js';

vi.mock('../../src/utils/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/password.js')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const PASSWORD = 'correct-horse-battery';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const T0 = new Date('2026-03-02T09:00:00.000Z');

const pool = createTestPool();
const env = getTestEnv();
const allowedOrigin = env.CORS_ORIGIN.split(',')[0]?.trim() ?? '';

let now = T0;
const sleeps: number[] = [];
let app: Express;

function makeApp(overrides: Partial<AppDeps> = {}): Express {
  return createApp({
    pool,
    env,
    clock: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
}

const post = (url: string, body?: unknown) =>
  request(app)
    .post(url)
    .set('X-Requested-With', 'XMLHttpRequest')
    .send(body as object);

const login = (password = PASSWORD, username = 'owner') =>
  post('/api/v1/auth/login', { username, password });

function tokenFrom(res: request.Response): string {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] ?? '';
  return raw.split(';')[0]?.split('=')[1] ?? '';
}

const me = (token: string) =>
  request(app).get('/api/v1/auth/me').set('Cookie', `store_sid=${token}`);

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await pool.query<RowDataPacket[]>(sql, params);
  return r;
}

beforeEach(async () => {
  await cleanDatabase(pool);
  now = T0;
  sleeps.length = 0;
  vi.mocked(verifyPassword).mockClear();
  app = makeApp();
  await createAdmin(pool, { username: 'owner', password: PASSWORD }, () => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe('POST /api/v1/auth/login', () => {
  it('logs in, returns the user and never puts the token in the body', async () => {
    const res = await login();
    const token = tokenFrom(res);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: expect.any(Number), username: 'owner' } });
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain(PASSWORD);
  });

  it('sets an HttpOnly, SameSite=Lax, 7-day cookie (no Secure outside production)', async () => {
    const res = await login();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cookie).toMatch(/^store_sid=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure in production and Domain when COOKIE_DOMAIN is set', async () => {
    app = makeApp({ env: { ...env, NODE_ENV: 'production', COOKIE_DOMAIN: 'store.example.test' } });
    const cookie = ((await login()).headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Domain=store.example.test');
  });

  it('stores only the SHA-256 of the token, and records last login and audit', async () => {
    const token = tokenFrom(await login());
    const sessions = await rows('SELECT token_hash, expires_at FROM sessions');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(sessions[0]?.token_hash).not.toBe(token);
    expect(sessions[0]?.expires_at).toBe('2026-03-09 09:00:00.000');
    expect((await rows('SELECT last_login_at FROM users'))[0]?.last_login_at).toBe(
      '2026-03-02 09:00:00.000',
    );
    expect(await rows("SELECT id FROM audit_log WHERE action = 'login_success'")).toHaveLength(1);
  });

  it('answers identically for unknown user, wrong password and inactive user', async () => {
    await pool.query(
      "INSERT INTO users (username, password_hash, is_active) SELECT 'off', password_hash, 0 FROM users LIMIT 1",
    );
    const responses = [
      await login(PASSWORD, 'ghost'),
      await login('wrong-password-123'),
      await login(PASSWORD, 'off'),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).toEqual({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Username atau password salah.',
          details: [],
        },
      });
    }
  });

  it('still verifies a password for unknown users (timing equalisation)', async () => {
    await login(PASSWORD, 'ghost');
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
  });

  it('does not store the typed username of an unknown user, nor any password', async () => {
    await login('wrong-password-123', 'ghost');
    await login('wrong-password-123');
    const failed = await rows(
      "SELECT user_id, after_json FROM audit_log WHERE action = 'login_failed' ORDER BY id",
    );
    expect(failed).toHaveLength(2);
    expect(failed[0]?.user_id).toBeNull();
    expect(failed[0]?.after_json).toEqual({ reason: 'unknown_user' });
    expect(failed[1]?.user_id).not.toBeNull();
    const leaks = await rows(
      "SELECT id FROM audit_log WHERE CAST(after_json AS CHAR) LIKE '%ghost%' OR CAST(after_json AS CHAR) LIKE '%wrong-password%' OR CAST(after_json AS CHAR) LIKE ?",
      [`%${PASSWORD}%`],
    );
    expect(leaks).toHaveLength(0);
  });

  it('validates the body with the uniform error format', async () => {
    const empty = await post('/api/v1/auth/login', {});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
    expect(empty.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'password',
      'username',
    ]);

    const tooLong = await post('/api/v1/auth/login', {
      username: 'owner',
      password: 'x'.repeat(129),
    });
    expect(tooLong.status).toBe(400);
    expect((await post('/api/v1/auth/login', { username: 5, password: 'x' })).status).toBe(400);
  });

  it('rejects malformed and oversized JSON without leaking internals', async () => {
    const bad = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    expect(bad.text).not.toContain('stack');

    const big = await post('/api/v1/auth/login', {
      username: 'owner',
      password: 'x'.repeat(200_000),
    });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('never logs the password', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m));
    await login();
    await login('another-wrong-pass-1');
    await post('/api/v1/auth/login', { username: 'owner' });
    const printed = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain('another-wrong-pass-1');
  });
});

describe('brute-force protection', () => {
  it('delays progressively after repeated failures and resets on success', async () => {
    for (let i = 0; i < 6; i++) await login('wrong-password-123');
    expect(sleeps).toEqual([500, 1000, 2000]);

    expect((await login()).status).toBe(200);
    sleeps.length = 0;
    for (let i = 0; i < 3; i++) await login('wrong-password-123');
    expect(sleeps).toEqual([]);
  });

  it('caps the delay at 8 seconds', async () => {
    for (let i = 0; i < 12; i++) await login('wrong-password-123');
    expect(Math.max(...sleeps)).toBe(8000);
  });

  it('answers 429 with Retry-After once the failure limit is hit', async () => {
    app = makeApp({ loginRateLimit: { windowMs: 60_000, limit: 3 } });
    for (let i = 0; i < 3; i++) expect((await login('wrong-password-123')).status).toBe(401);
    const blocked = await login('wrong-password-123');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('does not count successful logins towards the limit', async () => {
    app = makeApp({ loginRateLimit: { windowMs: 60_000, limit: 3 } });
    for (let i = 0; i < 6; i++) expect((await login()).status).toBe(200);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without the custom header', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'owner', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(403);
  });

  it('rejects an Origin outside the allowlist and accepts an allowed one', async () => {
    const evil = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Origin', 'https://evil.example')
      .send({ username: 'owner', password: PASSWORD });
    expect(evil.status).toBe(403);

    const ok = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Origin', allowedOrigin)
      .send({ username: 'owner', password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('does not require the header for safe methods', async () => {
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('access control', () => {
  it('returns 401 without a session or with an unknown token', async () => {
    const none = await request(app).get('/api/v1/auth/me');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('UNAUTHENTICATED');
    expect((await me('not-a-real-token')).status).toBe(401);
  });

  it('protects unknown /api/v1 routes too, and 404s them only with a session', async () => {
    expect((await request(app).get('/api/v1/anything')).status).toBe(401);
    const token = tokenFrom(await login());
    expect(
      (await request(app).get('/api/v1/anything').set('Cookie', `store_sid=${token}`)).status,
    ).toBe(404);
  });

  it('keeps /health public and returns the user for a valid session', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    const token = tokenFrom(await login());
    const res = await me(token);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('owner');
  });

  it('rejects revoked sessions and sessions of deactivated users', async () => {
    const token = tokenFrom(await login());
    await pool.query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3)');
    expect((await me(token)).status).toBe(401);

    const second = tokenFrom(await login());
    expect((await me(second)).status).toBe(200);
    await pool.query('UPDATE users SET is_active = 0');
    expect((await me(second)).status).toBe(401);
  });
});

describe('session lifetime', () => {
  it('expires after 12 hours idle', async () => {
    const token = tokenFrom(await login());
    now = new Date(T0.getTime() + 12 * HOUR + MINUTE);
    expect((await me(token)).status).toBe(401);
  });

  it('activity keeps the session alive but never past the absolute 7 days', async () => {
    const token = tokenFrom(await login());
    let elapsedHours = 0;
    while (elapsedHours + 10 < 168) {
      elapsedHours += 10;
      now = new Date(T0.getTime() + elapsedHours * HOUR);
      expect((await me(token)).status).toBe(200);
    }
    now = new Date(T0.getTime() + 170 * HOUR);
    expect((await me(token)).status).toBe(401);
  });

  it('updates last_seen_at at most once per minute', async () => {
    const token = tokenFrom(await login());
    now = new Date(T0.getTime() + 30_000);
    await me(token);
    expect((await rows('SELECT last_seen_at FROM sessions'))[0]?.last_seen_at).toBe(
      '2026-03-02 09:00:00.000',
    );
    now = new Date(T0.getTime() + 90_000);
    await me(token);
    expect((await rows('SELECT last_seen_at FROM sessions'))[0]?.last_seen_at).toBe(
      '2026-03-02 09:01:30.000',
    );
  });
});

describe('rotation', () => {
  it('revokes the session presented at login and issues a different token', async () => {
    const a = tokenFrom(await login());
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Cookie', `store_sid=${a}`)
      .send({ username: 'owner', password: PASSWORD });
    const b = tokenFrom(res);
    expect(b).not.toBe(a);
    expect((await me(a)).status).toBe(401);
    expect((await me(b)).status).toBe(200);
  });

  it('leaves sessions of other devices untouched', async () => {
    const phone = tokenFrom(await login());
    const laptop = tokenFrom(await login());
    expect((await me(phone)).status).toBe(200);
    expect((await me(laptop)).status).toBe(200);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the session, clears the cookie and writes an audit entry', async () => {
    const token = tokenFrom(await login());
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Cookie', `store_sid=${token}`);
    expect(res.status).toBe(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
    expect((await me(token)).status).toBe(401);
    expect((await rows('SELECT revoked_at FROM sessions'))[0]?.revoked_at).not.toBeNull();
    expect(await rows("SELECT id FROM audit_log WHERE action = 'logout'")).toHaveLength(1);
  });

  it('is idempotent: no session, garbage token or repeated logout all succeed', async () => {
    expect((await post('/api/v1/auth/logout')).status).toBe(204);
    const garbage = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Cookie', 'store_sid=garbage');
    expect(garbage.status).toBe(204);

    const token = tokenFrom(await login());
    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('X-Requested-With', 'XMLHttpRequest')
        .set('Cookie', `store_sid=${token}`);
      expect(res.status).toBe(204);
    }
    expect(await rows("SELECT id FROM audit_log WHERE action = 'logout'")).toHaveLength(1);
  });
});
