import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { createDbPool } from '../../src/config/db.js';
import { loadEnv } from '../../src/config/env.js';
import type { Env } from '../../src/config/env.js';

dotenv.config({ quiet: true });

// Tests may only touch databases whose name ends with _test (AGENTS.md §3, §10).
export function assertTestDatabase(name: string): void {
  if (!/_test$/.test(name)) {
    throw new Error(
      `Test ditolak: database "${name}" tidak berakhiran _test. Test hanya boleh jalan di database test.`,
    );
  }
}

export function getTestEnv(): Env {
  const name = process.env.TEST_DB_NAME ?? 'store_test';
  assertTestDatabase(name);
  return loadEnv({ ...process.env, NODE_ENV: 'test', DB_NAME: name });
}

export function createTestPool(connectionLimit?: number): Pool {
  const env = getTestEnv();
  assertTestDatabase(env.DB_NAME);
  return createDbPool(
    connectionLimit === undefined ? env : { ...env, DB_CONNECTION_LIMIT: connectionLimit },
  );
}

// Empties every table except schema_migrations. Guarded by the _test check.
export async function cleanDatabase(pool: Pool): Promise<void> {
  const [dbRows] = await pool.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS db');
  assertTestDatabase(String(dbRows[0]?.db));

  const [tables] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`,
  );
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) {
      await conn.query(`TRUNCATE TABLE ${conn.escapeId(String(t.name))}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}
