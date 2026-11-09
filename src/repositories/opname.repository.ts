import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { LossBorneBy, LossReason } from '../domain/opname.js';

export type Db = Pool | PoolConnection;

export interface OpnameItemEntity {
  id: number;
  opnameId: number;
  productId: number;
  ownerType: 'own' | 'consignor';
  consignorId: number | null;
  productNameSnapshot: string;
  sellPriceSnapshot: string;
  marginTypeSnapshot: 'nominal' | 'percent' | null;
  marginValueSnapshot: string | null;
  pcsPerPackSnapshot: number;
  openingQty: number;
  openingValue: string;
  inQty: number;
  inCost: string;
  returnedQty: number;
  expectedQty: number;
  physicalQty: number;
  diffQty: number;
  lossQty: number;
  soldQty: number;
  avgCost: string;
  cogs: string;
  ownLossCost: string;
  closingValue: string;
  turnover: string;
  ownerMarginPerPcs: string;
  consignorSharePerPcs: string;
  soldShare: string;
  lossQtyOwnerBorne: number;
  lossCompensation: string;
  payoutDue: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpnameConsignorPayoutEntity {
  id: number;
  opnameId: number;
  consignorId: number;
  consignorName?: string | undefined;
  soldShare: string;
  lossCompensation: string;
  payoutDue: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpnameEntity {
  id: number;
  opnameDate: string;
  status: 'draft' | 'final';
  note: string | null;
  totalTurnover: string;
  totalSoldQty: number;
  totalLossQty: number;
  totalCogs: string;
  totalPayoutDue: string;
  cashAmount: string;
  qrisAmount: string;
  realCash: string;
  cashDifference: string;
  profitA: string;
  profitB: string;
  createdAt: string;
  updatedAt: string;
  items?: OpnameItemEntity[] | undefined;
  payouts?: OpnameConsignorPayoutEntity[] | undefined;
}

export interface ProductMovementSummary {
  productId: number;
  inQty: number;
  inCost: string;
  returnedQty: number;
  losses: { qty: number; reason: LossReason; borneBy: LossBorneBy; note?: string | undefined }[];
}

export interface OpnameFilterOptions {
  page: number;
  limit: number;
  status?: 'draft' | 'final' | 'all' | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  sortBy?: 'opname_date' | 'id' | 'created_at' | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
}

interface OpnameRow extends RowDataPacket {
  id: number;
  opname_date: string;
  status: 'draft' | 'final';
  note: string | null;
  total_turnover: string;
  total_sold_qty: number;
  total_loss_qty: number;
  total_cogs: string;
  total_payout_due: string;
  cash_amount: string;
  qris_amount: string;
  real_cash: string;
  cash_difference: string;
  profit_a: string;
  profit_b: string;
  created_at: string;
  updated_at: string;
}

interface OpnameItemRow extends RowDataPacket {
  id: number;
  opname_id: number;
  product_id: number;
  owner_type: 'own' | 'consignor';
  consignor_id: number | null;
  product_name_snapshot: string;
  sell_price_snapshot: string;
  margin_type_snapshot: 'nominal' | 'percent' | null;
  margin_value_snapshot: string | null;
  pcs_per_pack_snapshot: number;
  opening_qty: number;
  opening_value: string;
  in_qty: number;
  in_cost: string;
  returned_qty: number;
  expected_qty: number;
  physical_qty: number;
  diff_qty: number;
  loss_qty: number;
  sold_qty: number;
  avg_cost: string;
  cogs: string;
  own_loss_cost: string;
  closing_value: string;
  turnover: string;
  owner_margin_per_pcs: string;
  consignor_share_per_pcs: string;
  sold_share: string;
  loss_qty_owner_borne: number;
  loss_compensation: string;
  payout_due: string;
  created_at: string;
  updated_at: string;
}

interface OpnamePayoutRow extends RowDataPacket {
  id: number;
  opname_id: number;
  consignor_id: number;
  consignor_name: string;
  sold_share: string;
  loss_compensation: string;
  payout_due: string;
  created_at: string;
  updated_at: string;
}

function mapOpnameRowToEntity(row: OpnameRow): OpnameEntity {
  return {
    id: row.id,
    opnameDate: row.opname_date,
    status: row.status,
    note: row.note,
    totalTurnover: String(row.total_turnover),
    totalSoldQty: Number(row.total_sold_qty),
    totalLossQty: Number(row.total_loss_qty),
    totalCogs: String(row.total_cogs),
    totalPayoutDue: String(row.total_payout_due),
    cashAmount: String(row.cash_amount ?? '0.0000'),
    qrisAmount: String(row.qris_amount ?? '0.0000'),
    realCash: String(row.real_cash ?? '0.0000'),
    cashDifference: String(row.cash_difference ?? '0.0000'),
    profitA: String(row.profit_a ?? '0.0000'),
    profitB: String(row.profit_b ?? '0.0000'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItemRowToEntity(row: OpnameItemRow): OpnameItemEntity {
  return {
    id: row.id,
    opnameId: row.opname_id,
    productId: row.product_id,
    ownerType: row.owner_type,
    consignorId: row.consignor_id === null ? null : Number(row.consignor_id),
    productNameSnapshot: row.product_name_snapshot,
    sellPriceSnapshot: String(row.sell_price_snapshot),
    marginTypeSnapshot: row.margin_type_snapshot,
    marginValueSnapshot: row.margin_value_snapshot === null ? null : String(row.margin_value_snapshot),
    pcsPerPackSnapshot: Number(row.pcs_per_pack_snapshot),
    openingQty: Number(row.opening_qty),
    openingValue: String(row.opening_value),
    inQty: Number(row.in_qty),
    inCost: String(row.in_cost),
    returnedQty: Number(row.returned_qty),
    expectedQty: Number(row.expected_qty),
    physicalQty: Number(row.physical_qty),
    diffQty: Number(row.diff_qty),
    lossQty: Number(row.loss_qty),
    soldQty: Number(row.sold_qty),
    avgCost: String(row.avg_cost),
    cogs: String(row.cogs),
    ownLossCost: String(row.own_loss_cost),
    closingValue: String(row.closing_value),
    turnover: String(row.turnover),
    ownerMarginPerPcs: String(row.owner_margin_per_pcs),
    consignorSharePerPcs: String(row.consignor_share_per_pcs),
    soldShare: String(row.sold_share),
    lossQtyOwnerBorne: Number(row.loss_qty_owner_borne),
    lossCompensation: String(row.loss_compensation),
    payoutDue: String(row.payout_due),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPayoutRowToEntity(row: OpnamePayoutRow): OpnameConsignorPayoutEntity {
  return {
    id: row.id,
    opnameId: row.opname_id,
    consignorId: row.consignor_id,
    consignorName: row.consignor_name,
    soldShare: String(row.sold_share),
    lossCompensation: String(row.loss_compensation),
    payoutDue: String(row.payout_due),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OpnameRepository {
  async findByDate(opnameDate: string, db: Db): Promise<OpnameEntity | null> {
    const [rows] = await db.execute<OpnameRow[]>(
      `SELECT
         id,
         DATE_FORMAT(opname_date, '%Y-%m-%d') AS opname_date,
         status,
         note,
         total_turnover,
         total_sold_qty,
         total_loss_qty,
         total_cogs,
         total_payout_due,
         cash_amount,
         qris_amount,
         real_cash,
         cash_difference,
         profit_a,
         profit_b,
         DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM opnames
       WHERE opname_date = ?`,
      [opnameDate],
    );
    const row = rows[0];
    return row ? mapOpnameRowToEntity(row) : null;
  }

  async findById(id: number, db: Db): Promise<OpnameEntity | null> {
    const [rows] = await db.execute<OpnameRow[]>(
      `SELECT
         id,
         DATE_FORMAT(opname_date, '%Y-%m-%d') AS opname_date,
         status,
         note,
         total_turnover,
         total_sold_qty,
         total_loss_qty,
         total_cogs,
         total_payout_due,
         cash_amount,
         qris_amount,
         real_cash,
         cash_difference,
         profit_a,
         profit_b,
         DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM opnames
       WHERE id = ?`,
      [id],
    );
    const header = rows[0];
    if (!header) return null;

    const entity = mapOpnameRowToEntity(header);

    // Fetch items
    const [itemRows] = await db.execute<OpnameItemRow[]>(
      `SELECT
         id, opname_id, product_id, owner_type, consignor_id,
         product_name_snapshot, sell_price_snapshot, margin_type_snapshot, margin_value_snapshot, pcs_per_pack_snapshot,
         opening_qty, opening_value, in_qty, in_cost, returned_qty, expected_qty, physical_qty, diff_qty, loss_qty, sold_qty,
         avg_cost, cogs, own_loss_cost, closing_value, turnover, owner_margin_per_pcs, consignor_share_per_pcs,
         sold_share, loss_qty_owner_borne, loss_compensation, payout_due,
         DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM opname_items
       WHERE opname_id = ?
       ORDER BY id ASC`,
      [id],
    );
    entity.items = itemRows.map(mapItemRowToEntity);

    // Fetch payouts
    const [payoutRows] = await db.execute<OpnamePayoutRow[]>(
      `SELECT
         p.id, p.opname_id, p.consignor_id, COALESCE(c.name, '') AS consignor_name,
         p.sold_share, p.loss_compensation, p.payout_due,
         DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(p.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM opname_consignor_payouts p
       LEFT JOIN consignors c ON c.id = p.consignor_id
       WHERE p.opname_id = ?
       ORDER BY p.id ASC`,
      [id],
    );
    entity.payouts = payoutRows.map(mapPayoutRowToEntity);

    return entity;
  }

  async findPreviousOpname(
    beforeDate: string,
    db: Db,
  ): Promise<Map<number, { closingQty: number; closingValue: string }>> {
    const [prevOpnameRows] = await db.execute<RowDataPacket[]>(
      `SELECT id
       FROM opnames
       WHERE status = 'final' AND opname_date < ?
       ORDER BY opname_date DESC
       LIMIT 1`,
      [beforeDate],
    );

    const prevId = prevOpnameRows[0]?.id;
    const map = new Map<number, { closingQty: number; closingValue: string }>();
    if (!prevId) return map;

    const [itemRows] = await db.execute<RowDataPacket[]>(
      `SELECT product_id, physical_qty, closing_value
       FROM opname_items
       WHERE opname_id = ?`,
      [prevId],
    );

    for (const r of itemRows) {
      map.set(Number(r.product_id), {
        closingQty: Number(r.physical_qty),
        closingValue: String(r.closing_value || '0.0000'),
      });
    }

    return map;
  }

  async findOpenMovements(
    opnameDate: string,
    db: Db,
  ): Promise<Map<number, ProductMovementSummary>> {
    const summaryMap = new Map<number, ProductMovementSummary>();

    function getOrCreate(productId: number): ProductMovementSummary {
      let existing = summaryMap.get(productId);
      if (!existing) {
        existing = {
          productId,
          inQty: 0,
          inCost: '0.0000',
          returnedQty: 0,
          losses: [],
        };
        summaryMap.set(productId, existing);
      }
      return existing;
    }

    // 1. Stock In lines
    const [inRows] = await db.execute<RowDataPacket[]>(
      `SELECT
         sil.product_id,
         COALESCE(SUM(sil.qty_pcs), 0) AS total_qty_pcs,
         COALESCE(SUM(sil.total_cost), '0.0000') AS total_cost
       FROM stock_in_lines sil
       JOIN stock_ins si ON si.id = sil.stock_in_id
       WHERE si.opname_id IS NULL AND si.date <= ?
       GROUP BY sil.product_id`,
      [opnameDate],
    );

    for (const r of inRows) {
      const item = getOrCreate(Number(r.product_id));
      item.inQty = Number(r.total_qty_pcs);
      item.inCost = String(r.total_cost);
    }

    // 2. Stock Returns
    const [returnRows] = await db.execute<RowDataPacket[]>(
      `SELECT
         product_id,
         COALESCE(SUM(qty_pcs), 0) AS total_returned_qty
       FROM stock_returns
       WHERE opname_id IS NULL AND date <= ?
       GROUP BY product_id`,
      [opnameDate],
    );

    for (const r of returnRows) {
      const item = getOrCreate(Number(r.product_id));
      item.returnedQty = Number(r.total_returned_qty);
    }

    // 3. Loss Records
    const [lossRows] = await db.execute<RowDataPacket[]>(
      `SELECT
         product_id,
         qty_pcs,
         reason,
         borne_by,
         note
       FROM loss_records
       WHERE opname_id IS NULL AND date <= ?
       ORDER BY id ASC`,
      [opnameDate],
    );

    for (const r of lossRows) {
      const item = getOrCreate(Number(r.product_id));
      item.losses.push({
        qty: Number(r.qty_pcs),
        reason: r.reason as LossReason,
        borneBy: r.borne_by as LossBorneBy,
        note: r.note ? String(r.note) : undefined,
      });
    }

    return summaryMap;
  }

  async saveOpnameHeader(
    data: {
      opnameDate: string;
      status: 'draft' | 'final';
      note: string | null;
      totalTurnover: string;
      totalSoldQty: number;
      totalLossQty: number;
      totalCogs: string;
      totalPayoutDue: string;
      cashAmount?: string;
      qrisAmount?: string;
      realCash?: string;
      cashDifference?: string;
      profitA?: string;
      profitB?: string;
    },
    db: Db,
  ): Promise<number> {
    const cashAmount = data.cashAmount ?? '0.0000';
    const qrisAmount = data.qrisAmount ?? '0.0000';
    const realCash = data.realCash ?? '0.0000';
    const cashDifference = data.cashDifference ?? '0.0000';
    const profitA = data.profitA ?? '0.0000';
    const profitB = data.profitB ?? '0.0000';

    const [existing] = await db.execute<RowDataPacket[]>(
      'SELECT id, status FROM opnames WHERE opname_date = ?',
      [data.opnameDate],
    );

    if (existing[0]) {
      const id = Number(existing[0].id);
      await db.execute(
        `UPDATE opnames
         SET status = ?, note = ?, total_turnover = ?, total_sold_qty = ?,
             total_loss_qty = ?, total_cogs = ?, total_payout_due = ?,
             cash_amount = ?, qris_amount = ?, real_cash = ?,
             cash_difference = ?, profit_a = ?, profit_b = ?
         WHERE id = ?`,
        [
          data.status,
          data.note,
          data.totalTurnover,
          data.totalSoldQty,
          data.totalLossQty,
          data.totalCogs,
          data.totalPayoutDue,
          cashAmount,
          qrisAmount,
          realCash,
          cashDifference,
          profitA,
          profitB,
          id,
        ],
      );
      return id;
    }

    const [res] = await db.execute<ResultSetHeader>(
      `INSERT INTO opnames
         (opname_date, status, note, total_turnover, total_sold_qty, total_loss_qty, total_cogs, total_payout_due,
          cash_amount, qris_amount, real_cash, cash_difference, profit_a, profit_b)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.opnameDate,
        data.status,
        data.note,
        data.totalTurnover,
        data.totalSoldQty,
        data.totalLossQty,
        data.totalCogs,
        data.totalPayoutDue,
        cashAmount,
        qrisAmount,
        realCash,
        cashDifference,
        profitA,
        profitB,
      ],
    );
    return res.insertId;
  }

  async getModalBelanjaOwnForOpname(opnameDate: string, opnameId: number | null, db: Db): Promise<string> {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(sil.total_cost), 0) AS total_modal_belanja_own
       FROM stock_ins si
       JOIN stock_in_lines sil ON sil.stock_in_id = si.id
       JOIN products p ON p.id = sil.product_id
       WHERE (si.opname_id = ? OR (si.opname_id IS NULL AND si.date <= ?))
         AND p.owner_type = 'own' AND si.type = 'purchase'`,
      [opnameId ?? -1, opnameDate],
    );
    return String(rows[0]?.total_modal_belanja_own ?? '0.0000');
  }

  async saveOpnameItems(
    opnameId: number,
    items: Omit<OpnameItemEntity, 'id' | 'opnameId' | 'createdAt' | 'updatedAt'>[],
    db: Db,
  ): Promise<void> {
    await db.execute('DELETE FROM opname_items WHERE opname_id = ?', [opnameId]);

    for (const item of items) {
      await db.execute(
        `INSERT INTO opname_items (
           opname_id, product_id, owner_type, consignor_id,
           product_name_snapshot, sell_price_snapshot, margin_type_snapshot, margin_value_snapshot, pcs_per_pack_snapshot,
           opening_qty, opening_value, in_qty, in_cost, returned_qty, expected_qty, physical_qty, diff_qty, loss_qty, sold_qty,
           avg_cost, cogs, own_loss_cost, closing_value, turnover, owner_margin_per_pcs, consignor_share_per_pcs,
           sold_share, loss_qty_owner_borne, loss_compensation, payout_due
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          opnameId,
          item.productId,
          item.ownerType,
          item.consignorId,
          item.productNameSnapshot,
          item.sellPriceSnapshot,
          item.marginTypeSnapshot,
          item.marginValueSnapshot,
          item.pcsPerPackSnapshot,
          item.openingQty,
          item.openingValue,
          item.inQty,
          item.inCost,
          item.returnedQty,
          item.expectedQty,
          item.physicalQty,
          item.diffQty,
          item.lossQty,
          item.soldQty,
          item.avgCost,
          item.cogs,
          item.ownLossCost,
          item.closingValue,
          item.turnover,
          item.ownerMarginPerPcs,
          item.consignorSharePerPcs,
          item.soldShare,
          item.lossQtyOwnerBorne,
          item.lossCompensation,
          item.payoutDue,
        ],
      );
    }
  }

  async saveOpnamePayouts(
    opnameId: number,
    payouts: { consignorId: number; soldShare: string; lossCompensation: string; payoutDue: string }[],
    db: Db,
  ): Promise<void> {
    await db.execute('DELETE FROM opname_consignor_payouts WHERE opname_id = ?', [opnameId]);

    for (const p of payouts) {
      await db.execute(
        `INSERT INTO opname_consignor_payouts (opname_id, consignor_id, sold_share, loss_compensation, payout_due)
         VALUES (?, ?, ?, ?, ?)`,
        [opnameId, p.consignorId, p.soldShare, p.lossCompensation, p.payoutDue],
      );
    }
  }

  async attachMovementsToOpname(opnameId: number, opnameDate: string, db: Db): Promise<void> {
    await db.execute(
      'UPDATE stock_ins SET opname_id = ? WHERE opname_id IS NULL AND date <= ?',
      [opnameId, opnameDate],
    );
    await db.execute(
      'UPDATE stock_returns SET opname_id = ? WHERE opname_id IS NULL AND date <= ?',
      [opnameId, opnameDate],
    );
    await db.execute(
      'UPDATE loss_records SET opname_id = ? WHERE opname_id IS NULL AND date <= ?',
      [opnameId, opnameDate],
    );
  }

  async list(
    options: OpnameFilterOptions,
    db: Db,
  ): Promise<{ data: OpnameEntity[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.status && options.status !== 'all') {
      conditions.push('status = ?');
      params.push(options.status);
    }

    if (options.startDate) {
      conditions.push('opname_date >= ?');
      params.push(options.startDate);
    }

    if (options.endDate) {
      conditions.push('opname_date <= ?');
      params.push(options.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) AS total FROM opnames ${whereClause}`;
    const [countRows] = await db.execute<RowDataPacket[]>(countSql, params);
    const total = Number(countRows[0]?.total ?? 0);

    const page = Math.max(1, options.page);
    const limit = Math.max(1, Math.min(100, options.limit));
    const offset = (page - 1) * limit;

    const allowedSortCols: Record<string, string> = {
      opname_date: 'opname_date',
      id: 'id',
      created_at: 'created_at',
    };
    const sortCol = allowedSortCols[options.sortBy ?? 'opname_date'] ?? 'opname_date';
    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const selectSql = `
      SELECT
        id,
        DATE_FORMAT(opname_date, '%Y-%m-%d') AS opname_date,
        status,
        note,
        total_turnover,
        total_sold_qty,
        total_loss_qty,
        total_cogs,
        total_payout_due,
        cash_amount,
        qris_amount,
        real_cash,
        cash_difference,
        profit_a,
        profit_b,
        DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
      FROM opnames
      ${whereClause}
      ORDER BY ${sortCol} ${sortOrder}, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await db.execute<OpnameRow[]>(selectSql, params);
    const data = rows.map(mapOpnameRowToEntity);

    return { data, total };
  }

  async deleteDraft(id: number, db: Db): Promise<void> {
    await db.execute("DELETE FROM opnames WHERE id = ? AND status = 'draft'", [id]);
  }
}
