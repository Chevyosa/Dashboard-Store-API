import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../../src/config/db.js';
import { cleanDatabase, createTestPool } from '../helpers/db.js';

const pool = createTestPool(1); // one connection: a leaked connection would hang the next query

beforeEach(async () => {
  await cleanDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

async function countUsers(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
  return Number(rows[0]?.n);
}

const insertUser = 'INSERT INTO users (username, password_hash) VALUES (?, ?)';

describe('withTransaction', () => {
  it('commits on success and returns the callback result', async () => {
    const result = await withTransaction(pool, async (conn) => {
      await conn.execute(insertUser, ['a', 'h']);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await countUsers()).toBe(1);
  });

  it('rolls back every statement when the callback throws', async () => {
    await expect(
      withTransaction(pool, async (conn) => {
        await conn.execute(insertUser, ['a', 'h']);
        await conn.execute(insertUser, ['b', 'h']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await countUsers()).toBe(0);
  });

  it('rolls back when a statement fails midway (duplicate key)', async () => {
    await expect(
      withTransaction(pool, async (conn) => {
        await conn.execute(insertUser, ['dup', 'h']);
        await conn.execute(insertUser, ['dup', 'h']);
      }),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(await countUsers()).toBe(0);
  });

  it('always releases the connection back to the pool', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(withTransaction(pool, () => Promise.reject(new Error('fail')))).rejects.toThrow(
        'fail',
      );
    }
    await expect(withTransaction(pool, async () => 'still works')).resolves.toBe('still works');
  });
});

describe('pool configuration (AGENTS.md §7, BR-01, BR-05)', () => {
  it('returns DECIMAL and date/time values as strings', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT CAST('1234567.8912' AS DECIMAL(20,4)) AS money,
              CAST('2026-10-04' AS DATE) AS d,
              CAST('2026-10-04 01:02:03.456' AS DATETIME(3)) AS ts`,
    );
    expect(rows[0]).toEqual({
      money: '1234567.8912',
      d: '2026-10-04',
      ts: '2026-10-04 01:02:03.456',
    });
  });

  it('keeps very long decimals exact (no float rounding)', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT CAST('9999999999999999.9999' AS DECIMAL(20,4)) AS big",
    );
    expect(rows[0]?.big).toBe('9999999999999999.9999');
  });

  it('writes default timestamps in UTC regardless of server time zone', async () => {
    await pool.execute(insertUser, ['utc', 'h']);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP(3)) AS drift FROM users WHERE username = 'utc'`,
    );
    expect(Math.abs(Number(rows[0]?.drift))).toBeLessThan(5);
  });
});
