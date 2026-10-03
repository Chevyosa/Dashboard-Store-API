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
