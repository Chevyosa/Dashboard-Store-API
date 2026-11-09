import mysql from 'mysql2/promise';
import type { Env } from './env.js';

type DbEnv = Pick<
  Env,
  'DB_HOST' | 'DB_PORT' | 'DB_USER' | 'DB_PASSWORD' | 'DB_NAME' | 'DB_CONNECTION_LIMIT'
>;

// Pool options follow AGENTS.md §7: money stays string, dates stay string, UTC.
export function createDbPool(env: DbEnv): mysql.Pool {
  return mysql.createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    connectionLimit: env.DB_CONNECTION_LIMIT,
    timezone: 'Z',
    decimalNumbers: false,
    dateStrings: true,
    charset: 'utf8mb4',
  });
}

// Runs fn inside one transaction: commit on success, rollback on any error,
// and the connection always goes back to the pool (AGENTS.md §7).
export async function withTransaction<T>(
  pool: mysql.Pool,
  fn: (conn: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // Keep the original error; a failed rollback must not mask it.
    }
    throw err;
  } finally {
    conn.release();
  }
}
