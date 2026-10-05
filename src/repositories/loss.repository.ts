import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export type Db = Pool | PoolConnection;

export type LossReason =
  | 'expired'
  | 'damaged_on_display'
  | 'damaged_before_display'
  | 'lost'
  | 'other';

export type LossBorneBy = 'owner' | 'consignor';

export interface LossEntity {
  id: number;
  productId: number;
  productName: string;
  ownerType: 'own' | 'consignor';
  consignorId: number | null;
  consignorName: string | null;
  sellPrice: string;
  marginType: 'nominal' | 'percent' | null;
  marginValue: string | null;
  qtyPcs: number;
  reason: LossReason;
  borneBy: LossBorneBy;
  date: string;
  note: string | null;
  opnameId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLossData {
  productId: number;
  qtyPcs: number;
  reason: LossReason;
  borneBy: LossBorneBy;
  date: string;
  note: string | null;
}

export interface UpdateLossData {
  productId?: number | undefined;
  qtyPcs?: number | undefined;
  reason?: LossReason | undefined;
  borneBy?: LossBorneBy | undefined;
  date?: string | undefined;
  note?: string | null | undefined;
}

export interface LossFilterOptions {
  page: number;
  limit: number;
  period?: 'open' | 'closed' | 'all' | undefined;
  reason?: LossReason | undefined;
  borneBy?: LossBorneBy | undefined;
  productId?: number | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  sortBy?: 'date' | 'id' | 'qty_pcs' | 'created_at' | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
}

export interface LossSummary {
  totalPcs: number;
  totalRecords: number;
  totalOwnerBornePcs: number;
  totalConsignorBornePcs: number;
  breakdownByReason: Record<LossReason, number>;
}

interface LossRow extends RowDataPacket {
  id: number;
  product_id: number;
  product_name: string;
  owner_type: 'own' | 'consignor';
  consignor_id: number | null;
  consignor_name: string | null;
  sell_price: string;
  margin_type: 'nominal' | 'percent' | null;
  margin_value: string | null;
  qty_pcs: number;
  reason: LossReason;
  borne_by: LossBorneBy;
  date: string;
  note: string | null;
  opname_id: number | null;
  created_at: string;
  updated_at: string;
}

function mapLossRowToEntity(row: LossRow): LossEntity {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    ownerType: row.owner_type,
    consignorId: row.consignor_id === null ? null : Number(row.consignor_id),
    consignorName: row.consignor_name,
    sellPrice: String(row.sell_price),
    marginType: row.margin_type,
    marginValue: row.margin_value === null ? null : String(row.margin_value),
    qtyPcs: Number(row.qty_pcs),
    reason: row.reason,
    borneBy: row.borne_by,
    date: row.date,
    note: row.note,
    opnameId: row.opname_id === null ? null : Number(row.opname_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LossRepository {
  async create(data: CreateLossData, db: Db): Promise<LossEntity> {
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO loss_records (product_id, qty_pcs, reason, borne_by, date, note, opname_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [data.productId, data.qtyPcs, data.reason, data.borneBy, data.date, data.note],
    );

    const insertedId = result.insertId;
    const created = await this.findById(insertedId, db);
    if (!created) {
      throw new Error(`Gagal memuat record loss yang baru dibuat dengan id ${insertedId}`);
    }
    return created;
  }

  async findById(id: number, db: Db): Promise<LossEntity | null> {
    const [rows] = await db.execute<LossRow[]>(
      `SELECT
         l.id,
         l.product_id,
         p.name AS product_name,
         p.owner_type,
         p.consignor_id,
         c.name AS consignor_name,
         p.sell_price,
         p.margin_type,
         p.margin_value,
         l.qty_pcs,
         l.reason,
         l.borne_by,
         DATE_FORMAT(l.date, '%Y-%m-%d') AS date,
         l.note,
         l.opname_id,
         DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(l.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM loss_records l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN consignors c ON c.id = p.consignor_id
       WHERE l.id = ?`,
      [id],
    );

    const row = rows[0];
    return row ? mapLossRowToEntity(row) : null;
  }

  async list(
    options: LossFilterOptions,
    db: Db,
  ): Promise<{ data: LossEntity[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.productId) {
      conditions.push('l.product_id = ?');
      params.push(options.productId);
    }

    if (options.reason) {
      conditions.push('l.reason = ?');
      params.push(options.reason);
    }

    if (options.borneBy) {
      conditions.push('l.borne_by = ?');
      params.push(options.borneBy);
    }

    if (options.period === 'open') {
      conditions.push('l.opname_id IS NULL');
    } else if (options.period === 'closed') {
      conditions.push('l.opname_id IS NOT NULL');
    }

    if (options.startDate) {
      conditions.push('l.date >= ?');
      params.push(options.startDate);
    }

    if (options.endDate) {
      conditions.push('l.date <= ?');
      params.push(options.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) AS total FROM loss_records l ${whereClause}`;
    const [countRows] = await db.execute<RowDataPacket[]>(countSql, params);
    const total = Number(countRows[0]?.total ?? 0);

    const page = Math.max(1, options.page);
    const limit = Math.max(1, Math.min(100, options.limit));
    const offset = (page - 1) * limit;

    const allowedSortColumns: Record<string, string> = {
      date: 'l.date',
      id: 'l.id',
      qty_pcs: 'l.qty_pcs',
      created_at: 'l.created_at',
    };
    const sortCol = allowedSortColumns[options.sortBy ?? 'date'] ?? 'l.date';
    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const selectSql = `
      SELECT
        l.id,
        l.product_id,
        p.name AS product_name,
        p.owner_type,
        p.consignor_id,
        c.name AS consignor_name,
        p.sell_price,
        p.margin_type,
        p.margin_value,
        l.qty_pcs,
        l.reason,
        l.borne_by,
        DATE_FORMAT(l.date, '%Y-%m-%d') AS date,
        l.note,
        l.opname_id,
        DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(l.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
      FROM loss_records l
      JOIN products p ON p.id = l.product_id
      LEFT JOIN consignors c ON c.id = p.consignor_id
      ${whereClause}
      ORDER BY ${sortCol} ${sortOrder}, l.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await db.execute<LossRow[]>(selectSql, params);
    const data = rows.map(mapLossRowToEntity);

    return { data, total };
  }

  async update(id: number, data: UpdateLossData, db: Db): Promise<LossEntity> {
    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (data.productId !== undefined) {
      updates.push('product_id = ?');
      params.push(data.productId);
    }
    if (data.qtyPcs !== undefined) {
      updates.push('qty_pcs = ?');
      params.push(data.qtyPcs);
    }
    if (data.reason !== undefined) {
      updates.push('reason = ?');
      params.push(data.reason);
    }
    if (data.borneBy !== undefined) {
      updates.push('borne_by = ?');
      params.push(data.borneBy);
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
      await db.execute(`UPDATE loss_records SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const updated = await this.findById(id, db);
    if (!updated) {
      throw new Error(`Data loss dengan id ${id} tidak ditemukan setelah update.`);
    }
    return updated;
  }

  async delete(id: number, db: Db): Promise<void> {
    await db.execute('DELETE FROM loss_records WHERE id = ?', [id]);
  }

  async getOpenPeriodSummary(db: Db): Promise<LossSummary> {
    const sql = `
      SELECT
        l.reason,
        l.borne_by,
        COALESCE(SUM(l.qty_pcs), 0) AS total_qty_pcs,
        COUNT(l.id) AS count_records
      FROM loss_records l
      WHERE l.opname_id IS NULL
      GROUP BY l.reason, l.borne_by
    `;

    const [rows] = await db.execute<RowDataPacket[]>(sql);

    let totalPcs = 0;
    let totalRecords = 0;
    let totalOwnerBornePcs = 0;
    let totalConsignorBornePcs = 0;

    const breakdownByReason: Record<LossReason, number> = {
      expired: 0,
      damaged_on_display: 0,
      damaged_before_display: 0,
      lost: 0,
      other: 0,
    };

    for (const r of rows) {
      const qty = Number(r.total_qty_pcs);
      const count = Number(r.count_records);
      const reason = r.reason as LossReason;
      const borneBy = r.borne_by as LossBorneBy;

      totalPcs += qty;
      totalRecords += count;

      if (borneBy === 'owner') {
        totalOwnerBornePcs += qty;
      } else {
        totalConsignorBornePcs += qty;
      }

      if (reason in breakdownByReason) {
        breakdownByReason[reason] += qty;
      }
    }

    return {
      totalPcs,
      totalRecords,
      totalOwnerBornePcs,
      totalConsignorBornePcs,
      breakdownByReason,
    };
  }
}
