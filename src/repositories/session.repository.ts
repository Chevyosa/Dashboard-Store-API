import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { fromMysqlUtc, toMysqlUtc } from '../utils/time.js';
import type { Db } from './user.repository.js';

export interface SessionRecord {
  id: number;
  userId: number;
  username: string;
  userIsActive: boolean;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface SessionRow extends RowDataPacket {
  id: number;
  user_id: number;
  username: string;
  is_active: number;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export async function insertSession(
  db: Db,
  input: {
    userId: number;
    tokenHash: string;
    now: Date;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  const now = toMysqlUtc(input.now);
  await db.execute(
    `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.tokenHash,
      now,
      now,
      toMysqlUtc(input.expiresAt),
      input.ip,
      input.userAgent,
    ],
  );
}

export async function findSessionByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<SessionRecord | null> {
  const [rows] = await db.execute<SessionRow[]>(
    `SELECT s.id, s.user_id, u.username, u.is_active, s.last_seen_at, s.expires_at, s.revoked_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    username: row.username,
    userIsActive: row.is_active === 1,
    lastSeenAt: fromMysqlUtc(row.last_seen_at),
    expiresAt: fromMysqlUtc(row.expires_at),
    revokedAt: row.revoked_at === null ? null : fromMysqlUtc(row.revoked_at),
  };
}

export async function touchSession(db: Db, id: number, now: Date): Promise<void> {
  await db.execute('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [toMysqlUtc(now), id]);
}

export async function revokeSessionByTokenHash(
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<boolean> {
  const [res] = await db.execute<ResultSetHeader>(
    'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    [toMysqlUtc(now), tokenHash],
  );
  return res.affectedRows > 0;
}

export async function revokeAllSessionsForUser(db: Db, userId: number, now: Date): Promise<void> {
  await db.execute('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
    toMysqlUtc(now),
    userId,
  ]);
}
