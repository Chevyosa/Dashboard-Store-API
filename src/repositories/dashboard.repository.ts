import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

export type Db = Pool | PoolConnection;

export interface DashboardOverviewData {
  activeProductsCount: number;
  activeConsignorsCount: number;
  totalStockValuation: string;
  totalUnpaidConsignorBalance: string;
  latestOpname: {
    id: number;
    opnameDate: string;
    status: 'draft' | 'final';
    totalTurnover: string;
    totalSoldQty: number;
    totalLossQty: number;
    totalCogs: string;
    totalPayoutDue: string;
  } | null;
  hasActiveDraft: boolean;
  activeDraftDate: string | null;
}

export interface TurnoverBreakdown {
  ownTurnover: string;
  consignorTurnover: string;
  totalTurnover: string;
  ownPercentage: number;
  consignorPercentage: number;
}

export interface TopProductItem {
  productId: number;
  name: string;
  ownerType: 'own' | 'consignor';
  soldQty: number;
  turnover: string;
}

export interface PendingPayoutConsignorItem {
  consignorId: number;
  consignorName: string;
  phone: string | null;
  totalAccrual: string;
  totalPayment: string;
  balance: string;
}

export interface RecentOpnameSummary {
  id: number;
  opnameDate: string;
  status: 'draft' | 'final';
  totalTurnover: string;
  totalSoldQty: number;
  totalLossQty: number;
  totalCogs: string;
  totalPayoutDue: string;
}

export interface OpnameOption {
  id: number;
  opnameDate: string;
  status: 'draft' | 'final';
}

export class DashboardRepository {
  async getOverview(db: Db): Promise<DashboardOverviewData> {
    // 1. Counts
    const [prodCountRows] = await db.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM products WHERE is_active = 1',
    );
    const activeProductsCount = Number(prodCountRows[0]?.total ?? 0);

    const [consignorCountRows] = await db.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM consignors WHERE is_active = 1',
    );
    const activeConsignorsCount = Number(consignorCountRows[0]?.total ?? 0);

    // 2. Latest final opname
    const [latestOpnameRows] = await db.execute<RowDataPacket[]>(
      `SELECT
         id,
         DATE_FORMAT(opname_date, '%Y-%m-%d') AS opname_date,
         status,
         total_turnover,
         total_sold_qty,
         total_loss_qty,
         total_cogs,
         total_payout_due
       FROM opnames
       WHERE status = 'final'
       ORDER BY opname_date DESC, id DESC
       LIMIT 1`,
    );

    let latestOpname: DashboardOverviewData['latestOpname'] = null;
    let latestOpnameId: number | null = null;

    if (latestOpnameRows.length > 0 && latestOpnameRows[0]) {
      const row = latestOpnameRows[0];
      latestOpnameId = Number(row.id);
      latestOpname = {
        id: latestOpnameId,
        opnameDate: String(row.opname_date),
        status: row.status as 'draft' | 'final',
        totalTurnover: String(row.total_turnover),
        totalSoldQty: Number(row.total_sold_qty),
        totalLossQty: Number(row.total_loss_qty),
        totalCogs: String(row.total_cogs),
        totalPayoutDue: String(row.total_payout_due),
      };
    }

    // 3. Draft opname check
    const [draftRows] = await db.execute<RowDataPacket[]>(
      `SELECT id, DATE_FORMAT(opname_date, '%Y-%m-%d') AS opname_date
       FROM opnames
       WHERE status = 'draft'
       ORDER BY opname_date DESC, id DESC
       LIMIT 1`,
    );
    const hasActiveDraft = draftRows.length > 0;
    const activeDraftDate = draftRows[0] ? String(draftRows[0].opname_date) : null;

    // 4. Stock valuation: closing_value from latest final opname for own products
    let totalStockValuation = '0.0000';
    if (latestOpnameId !== null) {
      const [valRows] = await db.execute<RowDataPacket[]>(
        `SELECT COALESCE(SUM(closing_value), 0) AS total_val
         FROM opname_items
         WHERE opname_id = ? AND owner_type = 'own'`,
        [latestOpnameId],
      );
      if (valRows.length > 0 && valRows[0]?.total_val !== null) {
        totalStockValuation = String(valRows[0]?.total_val);
      }
    }

    // 5. Total unpaid consignor balance
    const [balanceRows] = await db.execute<RowDataPacket[]>(
      `SELECT
         COALESCE(
           (SELECT SUM(payout_due) FROM opname_consignor_payouts ocp
            JOIN opnames o ON o.id = ocp.opname_id WHERE o.status = 'final'),
           0
         ) -
         COALESCE(
           (SELECT SUM(amount) FROM consignor_payments),
           0
         ) AS unpaid_balance`,
    );
    const totalUnpaidConsignorBalance = String(balanceRows[0]?.unpaid_balance ?? '0.0000');

    return {
      activeProductsCount,
      activeConsignorsCount,
      totalStockValuation,
      totalUnpaidConsignorBalance,
      latestOpname,
      hasActiveDraft,
      activeDraftDate,
    };
  }

  async getTurnoverBreakdown(opnameId: number, db: Db): Promise<TurnoverBreakdown> {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         COALESCE(SUM(CASE WHEN owner_type = 'own' THEN turnover ELSE 0 END), 0) AS own_turnover,
         COALESCE(SUM(CASE WHEN owner_type = 'consignor' THEN turnover ELSE 0 END), 0) AS consignor_turnover,
         COALESCE(SUM(turnover), 0) AS total_turnover
       FROM opname_items
       WHERE opname_id = ?`,
      [opnameId],
    );

    const ownTurnover = String(rows[0]?.own_turnover ?? '0.0000');
    const consignorTurnover = String(rows[0]?.consignor_turnover ?? '0.0000');
    const totalTurnover = String(rows[0]?.total_turnover ?? '0.0000');

    const totalNum = Number(totalTurnover);
    let ownPercentage = 0;
    let consignorPercentage = 0;

    if (totalNum > 0) {
      ownPercentage = Math.round((Number(ownTurnover) / totalNum) * 100);
      consignorPercentage = 100 - ownPercentage;
    }

    return {
      ownTurnover,
      consignorTurnover,
      totalTurnover,
      ownPercentage,
      consignorPercentage,
    };
  }

  async getTopSellingProducts(opnameId: number, limit: number, db: Db): Promise<TopProductItem[]> {
    const safeLimit = Math.max(1, Math.min(20, limit));
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         product_id,
         product_name_snapshot,
         owner_type,
         sold_qty,
         turnover
       FROM opname_items
       WHERE opname_id = ?
       ORDER BY turnover DESC, sold_qty DESC
       LIMIT ${safeLimit}`,
      [opnameId],
    );

    return rows.map((r) => ({
      productId: Number(r.product_id),
      name: String(r.product_name_snapshot),
      ownerType: r.owner_type as 'own' | 'consignor',
      soldQty: Number(r.sold_qty),
      turnover: String(r.turnover),
    }));
  }

  async getPendingPayoutConsignors(limit: number, db: Db): Promise<PendingPayoutConsignorItem[]> {
    const safeLimit = Math.max(1, Math.min(20, limit));
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         c.id AS consignor_id,
         c.name AS consignor_name,
         c.phone,
         COALESCE(acc.total_accrual, '0.0000') AS total_accrual,
         COALESCE(pay.total_payment, '0.0000') AS total_payment,
         (COALESCE(acc.total_accrual, 0) - COALESCE(pay.total_payment, 0)) AS balance
       FROM consignors c
       JOIN (
         SELECT
           ocp.consignor_id,
           SUM(ocp.payout_due) AS total_accrual
         FROM opname_consignor_payouts ocp
         JOIN opnames o ON o.id = ocp.opname_id
         WHERE o.status = 'final'
         GROUP BY ocp.consignor_id
       ) acc ON acc.consignor_id = c.id
       LEFT JOIN (
         SELECT
           cp.consignor_id,
           SUM(cp.amount) AS total_payment
         FROM consignor_payments cp
         GROUP BY cp.consignor_id
       ) pay ON pay.consignor_id = c.id
       WHERE (COALESCE(acc.total_accrual, 0) - COALESCE(pay.total_payment, 0)) > 0
       ORDER BY balance DESC
       LIMIT ${safeLimit}`,
    );

    return rows.map((r) => ({
      consignorId: Number(r.consignor_id),
      consignorName: String(r.consignor_name),
      phone: r.phone ? String(r.phone) : null,
      totalAccrual: String(r.total_accrual),
      totalPayment: String(r.total_payment),
      balance: String(r.balance),
    }));
  }

  async getRecentOpnames(limit: number, db: Db): Promise<RecentOpnameSummary[]> {
    const safeLimit = Math.max(1, Math.min(20, limit));
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         id,
         DATE_FORMAT(opname_date, '%Y-%m-%d') AS opname_date,
         status,
         total_turnover,
         total_sold_qty,
         total_loss_qty,
         total_cogs,
         total_payout_due
       FROM opnames
       ORDER BY opname_date DESC, id DESC
       LIMIT ${safeLimit}`,
    );

    return rows.map((r) => ({
      id: Number(r.id),
      opnameDate: String(r.opname_date),
      status: r.status as 'draft' | 'final',
      totalTurnover: String(r.total_turnover),
      totalSoldQty: Number(r.total_sold_qty),
      totalLossQty: Number(r.total_loss_qty),
      totalCogs: String(r.total_cogs),
      totalPayoutDue: String(r.total_payout_due),
    }));
  }

  async getModalBelanjaOwn(opnameId: number, db: Db): Promise<string> {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(sil.total_cost), 0) AS total_modal_belanja_own
       FROM stock_ins si
       JOIN stock_in_lines sil ON sil.stock_in_id = si.id
       JOIN products p ON p.id = sil.product_id
       WHERE si.opname_id = ? AND p.owner_type = 'own' AND si.type = 'purchase'`,
      [opnameId],
    );

    return String(rows[0]?.total_modal_belanja_own ?? '0.0000');
  }

  async getFinalizedOpnameOptions(db: Db): Promise<OpnameOption[]> {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         id,
         DATE_FORMAT(opname_date, '%Y-%m-%d') AS opname_date,
         status
       FROM opnames
       WHERE status = 'final'
       ORDER BY opname_date DESC, id DESC`,
    );

    return rows.map((r) => ({
      id: Number(r.id),
      opnameDate: String(r.opname_date),
      status: r.status as 'draft' | 'final',
    }));
  }
}

export const dashboardRepository = new DashboardRepository();
