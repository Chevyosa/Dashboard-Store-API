import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export type Db = Pool | PoolConnection;
export type TakeProfitPaymentMethod = 'cash' | 'transfer';

export interface TakeProfitEntity {
  id: number;
  opnameId: number | null;
  opnameDate: string | null;
  amount: string;
  withdrawalDate: string;
  paymentMethod: TakeProfitPaymentMethod;
  note: string | null;
  createdBy: number | null;
  createdByUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTakeProfitData {
  opnameId?: number | null | undefined;
  amount: string;
  withdrawalDate: string;
  paymentMethod: TakeProfitPaymentMethod;
  note?: string | null | undefined;
  createdBy?: number | null | undefined;
}

export interface ListTakeProfitsOptions {
  page: number;
  limit: number;
  opnameId?: number | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

interface TakeProfitRow extends RowDataPacket {
  id: number;
  opname_id: number | null;
  opname_date: string | null;
  amount: string;
  withdrawal_date: string;
  payment_method: TakeProfitPaymentMethod;
  note: string | null;
  created_by: number | null;
  created_by_username: string | null;
  created_at: string;
  updated_at: string;
}

function mapTakeProfitRow(row: TakeProfitRow): TakeProfitEntity {
  return {
    id: Number(row.id),
    opnameId: row.opname_id === null ? null : Number(row.opname_id),
    opnameDate: row.opname_date,
    amount: String(row.amount),
    withdrawalDate: row.withdrawal_date,
    paymentMethod: row.payment_method,
    note: row.note,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdByUsername: row.created_by_username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TakeProfitRepository {
  async getSetting(key: string, db: Db): Promise<string | null> {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT setting_value FROM store_settings WHERE setting_key = ?',
      [key],
    );
    if (rows.length === 0 || !rows[0]) return null;
    return String(rows[0].setting_value);
  }

  async setSetting(key: string, value: string, db: Db): Promise<void> {
    await db.execute(
      `INSERT INTO store_settings (setting_key, setting_value)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, value],
    );
  }

  async createTakeProfit(data: CreateTakeProfitData, db: Db): Promise<TakeProfitEntity> {
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO take_profits (
         opname_id,
         amount,
         withdrawal_date,
         payment_method,
         note,
         created_by
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        data.opnameId ?? null,
        data.amount,
        data.withdrawalDate,
        data.paymentMethod,
        data.note ?? null,
        data.createdBy ?? null,
      ],
    );

    const insertedId = result.insertId;
    const found = await this.findById(insertedId, db);
    if (!found) {
      throw new Error(`Gagal memuat take profit setelah disimpan (ID ${insertedId})`);
    }
    return found;
  }

  async findById(id: number, db: Db): Promise<TakeProfitEntity | null> {
    const [rows] = await db.execute<TakeProfitRow[]>(
      `SELECT
         tp.id,
         tp.opname_id,
         DATE_FORMAT(o.opname_date, '%Y-%m-%d') AS opname_date,
         tp.amount,
         DATE_FORMAT(tp.withdrawal_date, '%Y-%m-%d') AS withdrawal_date,
         tp.payment_method,
         tp.note,
         tp.created_by,
         u.username AS created_by_username,
         DATE_FORMAT(tp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(tp.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM take_profits tp
       LEFT JOIN opnames o ON o.id = tp.opname_id
       LEFT JOIN users u ON u.id = tp.created_by
       WHERE tp.id = ?`,
      [id],
    );

    if (rows.length === 0 || !rows[0]) return null;
    return mapTakeProfitRow(rows[0]);
  }

  async deleteTakeProfit(id: number, db: Db): Promise<void> {
    await db.execute('DELETE FROM take_profits WHERE id = ?', [id]);
  }

  async listTakeProfits(
    options: ListTakeProfitsOptions,
    db: Db,
  ): Promise<{ data: TakeProfitEntity[]; total: number }> {
    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.opnameId !== undefined) {
      whereClauses.push('tp.opname_id = ?');
      params.push(options.opnameId);
    }
    if (options.startDate) {
      whereClauses.push('tp.withdrawal_date >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      whereClauses.push('tp.withdrawal_date <= ?');
      params.push(options.endDate);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) AS total FROM take_profits tp ${whereSql}`;
    const [countRows] = await db.execute<RowDataPacket[]>(countSql, params);
    const total = Number(countRows[0]?.total ?? 0);

    const offset = (options.page - 1) * options.limit;
    const selectSql = `
      SELECT
        tp.id,
        tp.opname_id,
        DATE_FORMAT(o.opname_date, '%Y-%m-%d') AS opname_date,
        tp.amount,
        DATE_FORMAT(tp.withdrawal_date, '%Y-%m-%d') AS withdrawal_date,
        tp.payment_method,
        tp.note,
        tp.created_by,
        u.username AS created_by_username,
        DATE_FORMAT(tp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(tp.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
      FROM take_profits tp
      LEFT JOIN opnames o ON o.id = tp.opname_id
      LEFT JOIN users u ON u.id = tp.created_by
      ${whereSql}
      ORDER BY tp.withdrawal_date DESC, tp.id DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await db.execute<TakeProfitRow[]>(selectSql, [...params, options.limit, offset]);
    const data = rows.map(mapTakeProfitRow);

    return { data, total };
  }

  async getLatestFinalOpname(db: Db): Promise<{
    id: number;
    opnameDate: string;
    realCash: string;
    totalPayoutDue: string;
  } | null> {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         id,
         DATE_FORMAT(opname_date, '%Y-%m-%d') AS opname_date,
         real_cash,
         total_payout_due
       FROM opnames
       WHERE status = 'final'
       ORDER BY opname_date DESC, id DESC
       LIMIT 1`,
    );

    if (rows.length === 0 || !rows[0]) return null;
    return {
      id: Number(rows[0].id),
      opnameDate: String(rows[0].opname_date),
      realCash: String(rows[0].real_cash ?? '0.0000'),
      totalPayoutDue: String(rows[0].total_payout_due ?? '0.0000'),
    };
  }

  async getPayoutFinancialSummary(db: Db): Promise<{
    allTimeAccruals: string;
    allTimePayments: string;
  }> {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         COALESCE((SELECT SUM(total_payout_due) FROM opnames WHERE status = 'final'), 0) AS all_time_accruals,
         COALESCE((SELECT SUM(amount) FROM consignor_payments), 0) AS all_time_payments`,
    );
    return {
      allTimeAccruals: String(rows[0]?.all_time_accruals ?? '0.0000'),
      allTimePayments: String(rows[0]?.all_time_payments ?? '0.0000'),
    };
  }

  async getTotalUnpaidConsignorBalance(db: Db): Promise<string> {
    const [rows] = await db.execute<RowDataPacket[]>(
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
    return String(rows[0]?.unpaid_balance ?? '0.0000');
  }

  async getWithdrawnForOpname(opnameId: number, db: Db): Promise<string> {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT COALESCE(SUM(amount), 0) AS total_withdrawn FROM take_profits WHERE opname_id = ?',
      [opnameId],
    );
    return String(rows[0]?.total_withdrawn ?? '0.0000');
  }

  async getTotalWithdrawnAllTime(db: Db): Promise<string> {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT COALESCE(SUM(amount), 0) AS total_withdrawn FROM take_profits',
    );
    return String(rows[0]?.total_withdrawn ?? '0.0000');
  }
}
