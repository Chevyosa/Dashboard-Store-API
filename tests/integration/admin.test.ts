import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, resetAdminPassword } from '../../src/services/admin.service.js';
import { createAuthService } from '../../src/services/auth.service.js';
import { AppError } from '../../src/utils/errors.js';
import { cleanDatabase, createTestPool } from '../helpers/db.js';

const pool = createTestPool();
const GOOD = 'a-long-enough-password';

async function rows(sql: string): Promise<RowDataPacket[]> {
  const [r] = await pool.query<RowDataPacket[]>(sql);
  return r;
}

beforeEach(async () => {
  await cleanDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('createAdmin', () => {
  it('stores an argon2id hash (not the password) and writes an audit entry', async () => {
    await createAdmin(pool, { username: 'owner', password: GOOD });
    const [user] = await rows('SELECT password_hash FROM users');
    expect(user?.password_hash).toMatch(/^\$argon2id\$/);
    expect(user?.password_hash).not.toContain(GOOD);
    expect(await rows("SELECT id FROM audit_log WHERE action = 'admin_created'")).toHaveLength(1);
  });

  it('rejects passwords shorter than 12 characters and accepts exactly 12', async () => {
    await expect(
      createAdmin(pool, { username: 'owner', password: 'x'.repeat(11) }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      createAdmin(pool, { username: 'owner', password: 'x'.repeat(12) }),
    ).resolves.toBeGreaterThan(0);
  });

  it('rejects passwords above 128 characters and invalid usernames', async () => {
    await expect(
      createAdmin(pool, { username: 'owner', password: 'x'.repeat(129) }),
    ).rejects.toBeInstanceOf(AppError);
    for (const bad of ['ab', 'has space', 'a'.repeat(65), 'semi;colon']) {
      await expect(createAdmin(pool, { username: bad, password: GOOD })).rejects.toBeInstanceOf(
        AppError,
      );
    }
  });

  it('rejects a duplicate username with 409', async () => {
    await createAdmin(pool, { username: 'owner', password: GOOD });
    await expect(createAdmin(pool, { username: 'owner', password: GOOD })).rejects.toMatchObject({
      status: 409,
      code: 'USERNAME_TAKEN',
    });
  });
});

describe('resetAdminPassword', () => {
  it('changes the password, revokes every session and audits it', async () => {
    await createAdmin(pool, { username: 'owner', password: GOOD });
    const auth = createAuthService({ pool, sleep: () => Promise.resolve() });
    const client = { ip: '127.0.0.1', userAgent: 'test' };
    const phone = await auth.login({
      username: 'owner',
      password: GOOD,
      previousToken: undefined,
      client,
    });
    const laptop = await auth.login({
      username: 'owner',
      password: GOOD,
      previousToken: undefined,
      client,
    });

    await resetAdminPassword(pool, { username: 'owner', password: 'brand-new-password-1' });

    expect(await auth.authenticate(phone.token)).toBeNull();
    expect(await auth.authenticate(laptop.token)).toBeNull();
    await expect(
      auth.login({ username: 'owner', password: GOOD, previousToken: undefined, client }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      auth.login({
        username: 'owner',
        password: 'brand-new-password-1',
        previousToken: undefined,
        client,
      }),
    ).resolves.toHaveProperty('token');
    expect(
      await rows("SELECT id FROM audit_log WHERE action = 'admin_password_reset'"),
    ).toHaveLength(1);
  });

  it('fails for an unknown user and for a too-short password', async () => {
    await expect(
      resetAdminPassword(pool, { username: 'ghost', password: GOOD }),
    ).rejects.toMatchObject({ status: 404 });
    await createAdmin(pool, { username: 'owner', password: GOOD });
    await expect(
      resetAdminPassword(pool, { username: 'owner', password: 'short' }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});
