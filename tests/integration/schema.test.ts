import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { cleanDatabase, createTestPool } from '../helpers/db.js';

const pool = createTestPool();

beforeEach(async () => {
  await cleanDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

async function addUser(username: string): Promise<number> {
  const [res] = await pool.execute<ResultSetHeader>(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    [username, 'hash'],
  );
  return res.insertId;
}

const insertSession =
  "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, '2030-01-01 00:00:00')";
const hash = (c: string): string => c.repeat(64);

describe('users', () => {
  it('rejects duplicate usernames (case-insensitive)', async () => {
    await addUser('admin');
    await expect(addUser('ADMIN')).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });
});

describe('sessions', () => {
  it('rejects a session for a missing user', async () => {
    await expect(pool.execute(insertSession, [999999, hash('a')])).rejects.toMatchObject({
      code: 'ER_NO_REFERENCED_ROW_2',
    });
  });

  it('rejects duplicate token hashes', async () => {
    const id = await addUser('admin');
    await pool.execute(insertSession, [id, hash('a')]);
    await expect(pool.execute(insertSession, [id, hash('a')])).rejects.toMatchObject({
      code: 'ER_DUP_ENTRY',
    });
  });

  it('is removed when its user is deleted (cascade)', async () => {
    const id = await addUser('admin');
    await pool.execute(insertSession, [id, hash('a')]);
    await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM sessions');
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('audit_log', () => {
  it('accepts entries without a user (failed login) and stores JSON snapshots', async () => {
    await pool.execute('INSERT INTO audit_log (action, after_json) VALUES (?, CAST(? AS JSON))', [
      'login_failed',
      JSON.stringify({ username: 'x' }),
    ]);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT user_id, after_json FROM audit_log');
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.after_json).toEqual({ username: 'x' });
  });

  it('keeps history but nulls user_id when the user is deleted', async () => {
    const id = await addUser('admin');
    await pool.execute('INSERT INTO audit_log (user_id, action) VALUES (?, ?)', [id, 'login']);
    await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT user_id FROM audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBeNull();
  });

  it('rejects an entry for a missing user', async () => {
    await expect(
      pool.execute('INSERT INTO audit_log (user_id, action) VALUES (?, ?)', [999999, 'x']),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
  });
});
