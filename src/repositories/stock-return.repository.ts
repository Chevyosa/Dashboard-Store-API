import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export type Db = Pool | PoolConnection;

export interface StockReturnEntity {
  id: number;
  productId: number;
  productName: string;
  consignorId: number | null;
  consignorName: string | null;
  qtyPcs: number;
  date: string;
  note: string | null;
  opnameId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStockReturnData {
  productId: number;
  qtyPcs: number;
  date: string;
  note: string | null;
}

export interface UpdateStockReturnData {
  qtyPcs?: number | undefined;
  date?: string | undefined;
  note?: string | null | undefined;
}

export interface StockReturnFilterOptions {
  page: number;
  limit: number;
  productId?: number | undefined;
  consignorId?: number | undefined;
  period?: 'open' | 'closed' | 'all' | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

interface StockReturnRow extends RowDataPacket {
  id: number;
  product_id: number;
  product_name: string;
  consignor_id: number | null;
  consignor_name: string | null;
  qty_pcs: number;
  date: string;
  note: string | null;
  opname_id: number | null;
  created_at: string;
  updated_at: string;
}

function mapReturnRowToEntity(row: StockReturnRow): StockReturnEntity {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    consignorId: row.consignor_id === null ? null : Number(row.consignor_id),
    consignorName: row.consignor_name,
    qtyPcs: Number(row.qty_pcs),
    date: row.date,
    note: row.note,
    opnameId: row.opname_id === null ? null : Number(row.opname_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class StockReturnRepository {
  async create(data: CreateStockReturnData, db: Db): Promise<StockReturnEntity> {
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO stock_returns (product_id, qty_pcs, date, note, opname_id) VALUES (?, ?, ?, ?, NULL)`,
      [data.productId, data.qtyPcs, data.date, data.note],
    );

    const insertedId = result.insertId;
    const created = await this.findById(insertedId, db);
    if (!created) {
      throw new Error(`Gagal memuat retur yang baru dibuat dengan id ${insertedId}`);
    }
    return created;
  }

  async findById(id: number, db: Db): Promise<StockReturnEntity | null> {
    const [rows] = await db.execute<StockReturnRow[]>(
      `SELECT
         sr.id,
         sr.product_id,
         p.name AS product_name,
         p.consignor_id,
         c.name AS consignor_name,
         sr.qty_pcs,
         DATE_FORMAT(sr.date, '%Y-%m-%d') AS date,
         sr.note,
         sr.opname_id,
         DATE_FORMAT(sr.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(sr.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM stock_returns sr
       JOIN products p ON p.id = sr.product_id
       LEFT JOIN consignors c ON c.id = p.consignor_id
       WHERE sr.id = ?`,
      [id],
    );

    const row = rows[0];
    return row ? mapReturnRowToEntity(row) : null;
  }

  async list(
    options: StockReturnFilterOptions,
    db: Db,
  ): Promise<{ data: StockReturnEntity[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.productId) {
      conditions.push('sr.product_id = ?');
      params.push(options.productId);
    }

    if (options.consignorId) {
      conditions.push('p.consignor_id = ?');
      params.push(options.consignorId);
    }

    if (options.period === 'open') {
      conditions.push('sr.opname_id IS NULL');
    } else if (options.period === 'closed') {
      conditions.push('sr.opname_id IS NOT NULL');
    }

    if (options.startDate) {
      conditions.push('sr.date >= ?');
      params.push(options.startDate);
    }

    if (options.endDate) {
      conditions.push('sr.date <= ?');
      params.push(options.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `
      SELECT COUNT(*) AS total
      FROM stock_returns sr
      JOIN products p ON p.id = sr.product_id
      ${whereClause}
    `;

    const [countRows] = await db.execute<RowDataPacket[]>(countSql, params);
    const total = Number(countRows[0]?.total ?? 0);

    const page = Math.max(1, options.page);
    const limit = Math.max(1, Math.min(100, options.limit));
    const offset = (page - 1) * limit;

    const selectSql = `
      SELECT
        sr.id,
        sr.product_id,
        p.name AS product_name,
        p.consignor_id,
        c.name AS consignor_name,
        sr.qty_pcs,
        DATE_FORMAT(sr.date, '%Y-%m-%d') AS date,
        sr.note,
        sr.opname_id,
        DATE_FORMAT(sr.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(sr.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
      FROM stock_returns sr
      JOIN products p ON p.id = sr.product_id
      LEFT JOIN consignors c ON c.id = p.consignor_id
      ${whereClause}
      ORDER BY sr.date DESC, sr.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await db.execute<StockReturnRow[]>(selectSql, params);

    const data = rows.map(mapReturnRowToEntity);
    return { data, total };
  }

  async update(id: number, data: UpdateStockReturnData, db: Db): Promise<StockReturnEntity> {
    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (data.qtyPcs !== undefined) {
      updates.push('qty_pcs = ?');
      params.push(data.qtyPcs);
    }
    if (data.date !== undefined) {
      updates.push('date = ?');
      params.push(data.date);
    }
    if (data.note !== undefined) {
      updates.push('note = ?');
      params.push(data.note);
    }

    if (updates.length > 0) {
      params.push(id);
      await db.execute(`UPDATE stock_returns SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const updated = await this.findById(id, db);
    if (!updated) {
      throw new Error(`Data retur dengan id ${id} tidak ditemukan setelah pembaruan.`);
    }
    return updated;
  }

  async delete(id: number, db: Db): Promise<void> {
    await db.execute(`DELETE FROM stock_returns WHERE id = ?`, [id]);
  }
}

export const stockReturnRepository = new StockReturnRepository();
