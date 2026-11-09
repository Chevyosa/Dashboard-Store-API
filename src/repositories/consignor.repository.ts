import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { toMysqlUtc } from '../utils/time.js';

export type Db = Pool | PoolConnection;

export interface ConsignorRecord {
  id: number;
  name: string;
  phone: string | null;
  note: string | null;
  defaultMarginType: 'nominal' | 'percent' | null;
  defaultMarginValue: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ConsignorRow extends RowDataPacket {
  id: number;
  name: string;
  phone: string | null;
  note: string | null;
  default_margin_type: 'nominal' | 'percent' | null;
  default_margin_value: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ConsignorRow): ConsignorRecord {
  return {
    id: Number(row.id),
    name: row.name,
    phone: row.phone,
    note: row.note,
    defaultMarginType: row.default_margin_type,
    defaultMarginValue: row.default_margin_value !== null ? String(row.default_margin_value) : null,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateConsignorInput {
  name: string;
  phone?: string | null | undefined;
  note?: string | null | undefined;
  defaultMarginType?: 'nominal' | 'percent' | null | undefined;
  defaultMarginValue?: string | null | undefined;
  now: Date;
}

export interface UpdateConsignorInput {
  name?: string | undefined;
  phone?: string | null | undefined;
  note?: string | null | undefined;
  defaultMarginType?: 'nominal' | 'percent' | null | undefined;
  defaultMarginValue?: string | null | undefined;
  now: Date;
}

export interface ListConsignorsParams {
  page: number;
  limit: number;
  search?: string | undefined;
  status: 'all' | 'active' | 'inactive';
  sortBy: 'name' | 'createdAt';
  sortOrder: 'asc' | 'desc';
}

const SORT_COLUMN_MAP: Record<string, string> = {
  name: 'name',
  createdAt: 'created_at',
};

export async function insertConsignor(db: Db, input: CreateConsignorInput): Promise<number> {
  const at = toMysqlUtc(input.now);
  const [res] = await db.execute<ResultSetHeader>(
    `INSERT INTO consignors (
      name, phone, note, default_margin_type, default_margin_value, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.phone ?? null,
      input.note ?? null,
      input.defaultMarginType ?? null,
      input.defaultMarginValue ?? null,
      at,
      at,
    ],
  );
  return res.insertId;
}

export async function findConsignorById(db: Db, id: number): Promise<ConsignorRecord | null> {
  const [rows] = await db.execute<ConsignorRow[]>(
    `SELECT id, name, phone, note, default_margin_type, default_margin_value, is_active, created_at, updated_at
     FROM consignors WHERE id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export async function findConsignorByName(db: Db, name: string): Promise<ConsignorRecord | null> {
  const [rows] = await db.execute<ConsignorRow[]>(
    `SELECT id, name, phone, note, default_margin_type, default_margin_value, is_active, created_at, updated_at
     FROM consignors WHERE name = ? LIMIT 1`,
    [name],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export async function listConsignors(
  db: Db,
  params: ListConsignorsParams,
): Promise<{ consignors: ConsignorRecord[]; total: number }> {
  const conditions: string[] = [];
  const args: (string | number | null)[] = [];

  if (params.status === 'active') {
    conditions.push('is_active = 1');
  } else if (params.status === 'inactive') {
    conditions.push('is_active = 0');
  }

  if (params.search && params.search.trim().length > 0) {
    conditions.push('name LIKE ?');
    args.push(`%${params.search.trim()}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const [countRows] = await db.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM consignors ${whereClause}`,
    args,
  );
  const total = Number(countRows[0]?.total ?? 0);

  // Sorting
  const sortCol = SORT_COLUMN_MAP[params.sortBy] ?? 'name';
  const sortDir = params.sortOrder === 'desc' ? 'DESC' : 'ASC';

  const offset = (params.page - 1) * params.limit;
  const listArgs = [...args, params.limit, offset];

  const [rows] = await db.query<ConsignorRow[]>(
    `SELECT id, name, phone, note, default_margin_type, default_margin_value, is_active, created_at, updated_at
     FROM consignors
     ${whereClause}
     ORDER BY ${sortCol} ${sortDir}
     LIMIT ? OFFSET ?`,
    listArgs,
  );

  return {
    consignors: rows.map(toRecord),
    total,
  };
}

export async function updateConsignor(
  db: Db,
  id: number,
  input: UpdateConsignorInput,
): Promise<ConsignorRecord | null> {
  const updates: string[] = [];
  const args: (string | number | null)[] = [];

  if (input.name !== undefined) {
    updates.push('name = ?');
    args.push(input.name);
  }
  if (input.phone !== undefined) {
    updates.push('phone = ?');
    args.push(input.phone);
  }
  if (input.note !== undefined) {
    updates.push('note = ?');
    args.push(input.note);
  }
  if (input.defaultMarginType !== undefined) {
    updates.push('default_margin_type = ?');
    args.push(input.defaultMarginType);
  }
  if (input.defaultMarginValue !== undefined) {
    updates.push('default_margin_value = ?');
    args.push(input.defaultMarginValue);
  }

  updates.push('updated_at = ?');
  args.push(toMysqlUtc(input.now));

  args.push(id);

  await db.execute(`UPDATE consignors SET ${updates.join(', ')} WHERE id = ?`, args);
  return findConsignorById(db, id);
}

export async function setConsignorStatus(
  db: Db,
  id: number,
  isActive: boolean,
  now: Date,
): Promise<ConsignorRecord | null> {
  const at = toMysqlUtc(now);
  await db.execute(
    'UPDATE consignors SET is_active = ?, updated_at = ? WHERE id = ?',
    [isActive ? 1 : 0, at, id],
  );
  return findConsignorById(db, id);
}
