import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export type Db = Pool | PoolConnection;

export interface StockInLineEntity {
  id: number;
  stockInId: number;
  productId: number;
  productName: string;
  ownerType: 'own' | 'consignor';
  consignorName: string | null;
  inputMode: 'pack' | 'pcs';
  qtyPack: number | null;
  pcsPerPackSnapshot: number;
  qtyPcs: number;
  totalCost: string;
  createdAt: string;
  updatedAt: string;
}

export interface StockInEntity {
  id: number;
  type: 'purchase' | 'consignment_in' | 'initial';
  date: string;
  note: string | null;
  opnameId: number | null;
  totalCost: string;
  totalQtyPcs: number;
  linesCount: number;
  lines?: StockInLineEntity[] | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStockInLineData {
  productId: number;
  inputMode: 'pack' | 'pcs';
  qtyPack: number | null;
  pcsPerPackSnapshot: number;
  qtyPcs: number;
  totalCost: string;
}

export interface CreateStockInData {
  type: 'purchase' | 'consignment_in' | 'initial';
  date: string;
  note: string | null;
  lines: CreateStockInLineData[];
}

export interface UpdateStockInData {
  date?: string | undefined;
  note?: string | null | undefined;
  lines?: CreateStockInLineData[] | undefined;
}

export interface StockInFilterOptions {
  page: number;
  limit: number;
  type?: 'purchase' | 'consignment_in' | 'initial' | undefined;
  period?: 'open' | 'closed' | 'all' | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

export interface StockInSummary {
  totalPurchaseCost: string;
  totalLines: number;
  totalOwnPcs: number;
  totalConsignorPcs: number;
  totalTransactions: number;
  openReturnsCount: number;
  openReturnedPcs: number;
}

interface StockInHeaderRow extends RowDataPacket {
  id: number;
  type: 'purchase' | 'consignment_in' | 'initial';
  date: string;
  note: string | null;
  opname_id: number | null;
  total_cost: string;
  total_qty_pcs: number;
  lines_count: number;
  created_at: string;
  updated_at: string;
}

interface StockInLineRow extends RowDataPacket {
  id: number;
  stock_in_id: number;
  product_id: number;
  product_name: string;
  owner_type: 'own' | 'consignor';
  consignor_name: string | null;
  input_mode: 'pack' | 'pcs';
  qty_pack: number | null;
  pcs_per_pack_snapshot: number;
  qty_pcs: number;
  total_cost: string;
  created_at: string;
  updated_at: string;
}

function mapLineRowToEntity(row: StockInLineRow): StockInLineEntity {
  return {
    id: row.id,
    stockInId: row.stock_in_id,
    productId: row.product_id,
    productName: row.product_name,
    ownerType: row.owner_type,
    consignorName: row.consignor_name,
    inputMode: row.input_mode,
    qtyPack: row.qty_pack === null ? null : Number(row.qty_pack),
    pcsPerPackSnapshot: Number(row.pcs_per_pack_snapshot),
    qtyPcs: Number(row.qty_pcs),
    totalCost: String(row.total_cost),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHeaderRowToEntity(row: StockInHeaderRow, lines?: StockInLineEntity[]): StockInEntity {
  return {
    id: row.id,
    type: row.type,
    date: row.date,
    note: row.note,
    opnameId: row.opname_id === null ? null : Number(row.opname_id),
    totalCost: String(row.total_cost || '0.0000'),
    totalQtyPcs: Number(row.total_qty_pcs || 0),
    linesCount: Number(row.lines_count || 0),
    lines,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class StockInRepository {
  async create(data: CreateStockInData, db: Db): Promise<StockInEntity> {
    const [headerResult] = await db.execute<ResultSetHeader>(
      `INSERT INTO stock_ins (type, date, note, opname_id) VALUES (?, ?, ?, NULL)`,
      [data.type, data.date, data.note],
    );

    const stockInId = headerResult.insertId;

    for (const line of data.lines) {
      await db.execute(
        `INSERT INTO stock_in_lines
          (stock_in_id, product_id, input_mode, qty_pack, pcs_per_pack_snapshot, qty_pcs, total_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          stockInId,
          line.productId,
          line.inputMode,
          line.qtyPack,
          line.pcsPerPackSnapshot,
          line.qtyPcs,
          line.totalCost,
        ],
      );
    }

    const created = await this.findById(stockInId, db);
    if (!created) {
      throw new Error(`Gagal memuat barang masuk yang baru dibuat dengan id ${stockInId}`);
    }
    return created;
  }

  async findById(id: number, db: Db): Promise<StockInEntity | null> {
    const [headerRows] = await db.execute<StockInHeaderRow[]>(
      `SELECT
         si.id,
         si.type,
         DATE_FORMAT(si.date, '%Y-%m-%d') AS date,
         si.note,
         si.opname_id,
         COALESCE(SUM(sil.total_cost), '0.0000') AS total_cost,
         COALESCE(SUM(sil.qty_pcs), 0) AS total_qty_pcs,
         COUNT(sil.id) AS lines_count,
         DATE_FORMAT(si.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(si.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM stock_ins si
       LEFT JOIN stock_in_lines sil ON sil.stock_in_id = si.id
       WHERE si.id = ?
       GROUP BY si.id`,
      [id],
    );

    const header = headerRows[0];
    if (!header) return null;

    const [lineRows] = await db.execute<StockInLineRow[]>(
      `SELECT
         sil.id,
         sil.stock_in_id,
         sil.product_id,
         p.name AS product_name,
         p.owner_type,
         c.name AS consignor_name,
         sil.input_mode,
         sil.qty_pack,
         sil.pcs_per_pack_snapshot,
         sil.qty_pcs,
         sil.total_cost,
         DATE_FORMAT(sil.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(sil.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM stock_in_lines sil
       JOIN products p ON p.id = sil.product_id
       LEFT JOIN consignors c ON c.id = p.consignor_id
       WHERE sil.stock_in_id = ?
       ORDER BY sil.id ASC`,
      [id],
    );

    const lines = lineRows.map(mapLineRowToEntity);
    return mapHeaderRowToEntity(header, lines);
  }

  async list(
    options: StockInFilterOptions,
    db: Db,
  ): Promise<{ data: StockInEntity[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.type) {
      conditions.push('si.type = ?');
      params.push(options.type);
    }

    if (options.period === 'open') {
      conditions.push('si.opname_id IS NULL');
    } else if (options.period === 'closed') {
      conditions.push('si.opname_id IS NOT NULL');
    }

    if (options.startDate) {
      conditions.push('si.date >= ?');
      params.push(options.startDate);
    }

    if (options.endDate) {
      conditions.push('si.date <= ?');
      params.push(options.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total rows
    const countSql = `SELECT COUNT(*) AS total FROM stock_ins si ${whereClause}`;
    const [countRows] = await db.execute<RowDataPacket[]>(countSql, params);
    const total = Number(countRows[0]?.total ?? 0);

    const page = Math.max(1, options.page);
    const limit = Math.max(1, Math.min(100, options.limit));
    const offset = (page - 1) * limit;

    const selectSql = `
      SELECT
        si.id,
        si.type,
        DATE_FORMAT(si.date, '%Y-%m-%d') AS date,
        si.note,
        si.opname_id,
        COALESCE(SUM(sil.total_cost), '0.0000') AS total_cost,
        COALESCE(SUM(sil.qty_pcs), 0) AS total_qty_pcs,
        COUNT(sil.id) AS lines_count,
        DATE_FORMAT(si.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(si.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
      FROM stock_ins si
      LEFT JOIN stock_in_lines sil ON sil.stock_in_id = si.id
      ${whereClause}
      GROUP BY si.id
      ORDER BY si.date DESC, si.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await db.execute<StockInHeaderRow[]>(selectSql, params);

    if (rows.length === 0) {
      return { data: [], total };
    }

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    const [lineRows] = await db.execute<StockInLineRow[]>(
      `SELECT
         sil.id,
         sil.stock_in_id,
         sil.product_id,
         p.name AS product_name,
         p.owner_type,
         c.name AS consignor_name,
         sil.input_mode,
         sil.qty_pack,
         sil.pcs_per_pack_snapshot,
         sil.qty_pcs,
         sil.total_cost,
         DATE_FORMAT(sil.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(sil.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM stock_in_lines sil
       JOIN products p ON p.id = sil.product_id
       LEFT JOIN consignors c ON c.id = p.consignor_id
       WHERE sil.stock_in_id IN (${placeholders})
       ORDER BY sil.id ASC`,
      ids,
    );

    const linesByStockInId = new Map<number, StockInLineEntity[]>();
    for (const lineRow of lineRows) {
      const lineEntity = mapLineRowToEntity(lineRow);
      const existing = linesByStockInId.get(lineEntity.stockInId);
      if (existing) {
        existing.push(lineEntity);
      } else {
        linesByStockInId.set(lineEntity.stockInId, [lineEntity]);
      }
    }

    const data = rows.map((r) => mapHeaderRowToEntity(r, linesByStockInId.get(r.id) ?? []));
    return { data, total };
  }

  async update(id: number, data: UpdateStockInData, db: Db): Promise<StockInEntity> {
    if (data.date !== undefined || data.note !== undefined) {
      const updates: string[] = [];
      const params: (string | number | null)[] = [];

      if (data.date !== undefined) {
        updates.push('date = ?');
        params.push(data.date);
      }
      if (data.note !== undefined) {
        updates.push('note = ?');
        params.push(data.note);
      }

      params.push(id);
      await db.execute(`UPDATE stock_ins SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    if (data.lines !== undefined) {
      // Atomic replace lines
      await db.execute(`DELETE FROM stock_in_lines WHERE stock_in_id = ?`, [id]);
      for (const line of data.lines) {
        await db.execute(
          `INSERT INTO stock_in_lines
            (stock_in_id, product_id, input_mode, qty_pack, pcs_per_pack_snapshot, qty_pcs, total_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            line.productId,
            line.inputMode,
            line.qtyPack,
            line.pcsPerPackSnapshot,
            line.qtyPcs,
            line.totalCost,
          ],
        );
      }
    }

    const updated = await this.findById(id, db);
    if (!updated) {
      throw new Error(`Barang masuk dengan id ${id} tidak ditemukan setelah pembaruan.`);
    }
    return updated;
  }

  async delete(id: number, db: Db): Promise<void> {
    await db.execute(`DELETE FROM stock_ins WHERE id = ?`, [id]);
  }

  async getOpenPeriodSummary(db: Db): Promise<StockInSummary> {
    // 1. Total modal belanja own di open period (type purchase/initial with own products)
    const [costRows] = await db.execute<RowDataPacket[]>(
      `SELECT
         COALESCE(SUM(sil.total_cost), '0.0000') AS total_purchase_cost,
         COUNT(sil.id) AS total_lines,
         COALESCE(SUM(CASE WHEN p.owner_type = 'own' THEN sil.qty_pcs ELSE 0 END), 0) AS total_own_pcs,
         COALESCE(SUM(CASE WHEN p.owner_type = 'consignor' THEN sil.qty_pcs ELSE 0 END), 0) AS total_consignor_pcs,
         COUNT(DISTINCT si.id) AS total_transactions
       FROM stock_ins si
       JOIN stock_in_lines sil ON sil.stock_in_id = si.id
       JOIN products p ON p.id = sil.product_id
       WHERE si.opname_id IS NULL`,
    );

    const costRow = costRows[0];

    // 2. Returns in open period
    const [returnRows] = await db.execute<RowDataPacket[]>(
      `SELECT
         COUNT(id) AS open_returns_count,
         COALESCE(SUM(qty_pcs), 0) AS open_returned_pcs
       FROM stock_returns
       WHERE opname_id IS NULL`,
    );

    const returnRow = returnRows[0];

    return {
      totalPurchaseCost: String(costRow?.total_purchase_cost ?? '0.0000'),
      totalLines: Number(costRow?.total_lines ?? 0),
      totalOwnPcs: Number(costRow?.total_own_pcs ?? 0),
      totalConsignorPcs: Number(costRow?.total_consignor_pcs ?? 0),
      totalTransactions: Number(costRow?.total_transactions ?? 0),
      openReturnsCount: Number(returnRow?.open_returns_count ?? 0),
      openReturnedPcs: Number(returnRow?.open_returned_pcs ?? 0),
    };
  }
}

export const stockInRepository = new StockInRepository();
