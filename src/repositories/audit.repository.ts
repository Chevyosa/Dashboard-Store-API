import type { RowDataPacket } from 'mysql2/promise';
import { toMysqlUtc } from '../utils/time.js';
import type { Db } from './user.repository.js';

export interface AuditEntry {
  userId: number | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip: string | null;
  userAgent: string | null;
  at: Date;
}

const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

export async function insertAuditEntry(db: Db, entry: AuditEntry): Promise<void> {
  await db.execute(
    `INSERT INTO audit_log
       (user_id, action, entity_type, entity_id, before_json, after_json, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?)`,
    [
      entry.userId,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      json(entry.before),
      json(entry.after),
      entry.ip,
      entry.userAgent,
      toMysqlUtc(entry.at),
    ],
  );
}

interface CountRow extends RowDataPacket {
  n: number;
}

// Failed logins for one user since that user's last successful login.
export async function countFailedLoginsForUser(
  db: Db,
  userId: number,
  since: Date,
): Promise<number> {
  const [rows] = await db.execute<CountRow[]>(
    `SELECT COUNT(*) AS n FROM audit_log
     WHERE action = 'login_failed' AND user_id = ? AND created_at > ?
       AND id > COALESCE((SELECT MAX(id) FROM audit_log WHERE action = 'login_success' AND user_id = ?), 0)`,
    [userId, toMysqlUtc(since), userId],
  );
  return Number(rows[0]?.n ?? 0);
}

// Failed logins from one IP since a successful login from that same IP.
export async function countFailedLoginsForIp(db: Db, ip: string, since: Date): Promise<number> {
  const [rows] = await db.execute<CountRow[]>(
    `SELECT COUNT(*) AS n FROM audit_log
     WHERE action = 'login_failed' AND ip = ? AND created_at > ?
       AND id > COALESCE((SELECT MAX(id) FROM audit_log WHERE action = 'login_success' AND ip = ?), 0)`,
    [ip, toMysqlUtc(since), ip],
  );
  return Number(rows[0]?.n ?? 0);
}
