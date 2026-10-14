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

export interface AuditLogEntity {
  id: number;
  userId: number | null;
  username: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown | null;
  after: unknown | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface ListAuditLogsOptions {
  page: number;
  limit: number;
  action?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  userId?: number | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  search?: string | undefined;
}

interface AuditLogRow extends RowDataPacket {
  id: number;
  user_id: number | null;
  username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before_json: unknown;
  after_json: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

function parseJsonField(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function mapRowToEntity(row: AuditLogRow): AuditLogEntity {
  return {
    id: row.id,
    userId: row.user_id === null ? null : Number(row.user_id),
    username: row.username ?? null,
    action: row.action,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    before: parseJsonField(row.before_json),
    after: parseJsonField(row.after_json),
    ip: row.ip ?? null,
    userAgent: row.user_agent ?? null,
    createdAt: row.created_at,
  };
}

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

export async function listAuditLogs(
  options: ListAuditLogsOptions,
  db: Db,
): Promise<{ data: AuditLogEntity[]; total: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options.action) {
    conditions.push('a.action = ?');
    params.push(options.action);
  }

  if (options.entityType) {
    conditions.push('a.entity_type = ?');
    params.push(options.entityType);
  }

  if (options.entityId) {
    conditions.push('a.entity_id = ?');
    params.push(options.entityId);
  }

  if (options.userId !== undefined) {
    conditions.push('a.user_id = ?');
    params.push(options.userId);
  }

  if (options.startDate) {
    conditions.push('a.created_at >= ?');
    params.push(`${options.startDate} 00:00:00`);
  }

  if (options.endDate) {
    conditions.push('a.created_at <= ?');
    params.push(`${options.endDate} 23:59:59.999`);
  }

  if (options.search) {
    conditions.push('(a.action LIKE ? OR a.entity_type LIKE ? OR a.entity_id LIKE ? OR u.username LIKE ? OR a.ip LIKE ?)');
    const term = `%${options.search}%`;
    params.push(term, term, term, term, term);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `
    SELECT COUNT(*) AS total
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    ${whereClause}
  `;

  const [countRows] = await db.execute<RowDataPacket[]>(countSql, params);
  const total = Number(countRows[0]?.total ?? 0);

  const page = Math.max(1, options.page);
  const limit = Math.max(1, Math.min(100, options.limit));
  const offset = (page - 1) * limit;

  const selectSql = `
    SELECT
      a.id,
      a.user_id,
      u.username,
      a.action,
      a.entity_type,
      a.entity_id,
      a.before_json,
      a.after_json,
      a.ip,
      a.user_agent,
      DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    ${whereClause}
    ORDER BY a.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const [rows] = await db.execute<AuditLogRow[]>(selectSql, params);
  const data = rows.map(mapRowToEntity);

  return { data, total };
}

export async function findAuditLogById(id: number, db: Db): Promise<AuditLogEntity | null> {
  const [rows] = await db.execute<AuditLogRow[]>(
    `SELECT
       a.id,
       a.user_id,
       u.username,
       a.action,
       a.entity_type,
       a.entity_id,
       a.before_json,
       a.after_json,
       a.ip,
       a.user_agent,
       DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.id = ?`,
    [id],
  );

  const row = rows[0];
  return row ? mapRowToEntity(row) : null;
}

export async function getDistinctFilterValues(db: Db): Promise<{ actions: string[]; entityTypes: string[] }> {
  const [actionRows] = await db.execute<RowDataPacket[]>(
    'SELECT DISTINCT action FROM audit_log ORDER BY action ASC',
  );
  const actions = actionRows.map((r) => String(r.action));

  const [typeRows] = await db.execute<RowDataPacket[]>(
    'SELECT DISTINCT entity_type FROM audit_log WHERE entity_type IS NOT NULL ORDER BY entity_type ASC',
  );
  const entityTypes = typeRows.map((r) => String(r.entity_type));

  return { actions, entityTypes };
}
