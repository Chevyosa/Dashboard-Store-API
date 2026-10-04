import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { toMysqlUtc } from '../utils/time.js';

export type Db = Pool | PoolConnection;

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
  isActive: boolean;
}

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  is_active: number;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    username: row.username,
    passwordHash: row.password_hash,
    isActive: row.is_active === 1,
  };
}

export async function findUserByUsername(db: Db, username: string): Promise<UserRecord | null> {
  const [rows] = await db.execute<UserRow[]>(
    'SELECT id, username, password_hash, is_active FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export async function insertUser(
  db: Db,
  input: { username: string; passwordHash: string; now: Date },
): Promise<number> {
  const at = toMysqlUtc(input.now);
  const [res] = await db.execute<ResultSetHeader>(
    'INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [input.username, input.passwordHash, at, at],
  );
  return res.insertId;
}

export async function updateUserPassword(
  db: Db,
  input: { id: number; passwordHash: string; now: Date },
): Promise<void> {
  await db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    input.passwordHash,
    toMysqlUtc(input.now),
    input.id,
  ]);
}

export async function touchLastLogin(db: Db, id: number, now: Date): Promise<void> {
  const at = toMysqlUtc(now);
  await db.execute('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [at, at, id]);
}
