import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export type Db = Pool | PoolConnection;

export type PaymentMethod = 'cash' | 'transfer' | 'qris';

export interface ConsignorPaymentEntity {
  id: number;
  consignorId: number;
  consignorName: string;
  opnameId: number | null;
  opnameDate: string | null;
  amount: string;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  note: string | null;
  createdBy: number | null;
  createdByUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePaymentData {
  consignorId: number;
  opnameId?: number | null | undefined;
  amount: string;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  note?: string | null | undefined;
  createdBy?: number | null | undefined;
}

export interface ConsignorAccrualRow {
  id: number;
  opnameId: number;
  opnameDate: string;
  consignorId: number;
  soldShare: string;
  lossCompensation: string;
  payoutDue: string;
  createdAt: string;
}

export interface ConsignorFinancialRow {
  consignorId: number;
  consignorName: string;
  phone: string | null;
  isActive: boolean;
  totalAccrual: string;
  totalPayment: string;
}

export interface ListPaymentsOptions {
  page: number;
  limit: number;
  consignorId?: number | undefined;
  opnameId?: number | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

interface PaymentRow extends RowDataPacket {
  id: number;
  consignor_id: number;
  consignor_name: string;
  opname_id: number | null;
  opname_date: string | null;
  amount: string;
  payment_date: string;
  payment_method: PaymentMethod;
  note: string | null;
  created_by: number | null;
  created_by_username: string | null;
  created_at: string;
  updated_at: string;
}

interface AccrualRow extends RowDataPacket {
  id: number;
  opname_id: number;
  opname_date: string;
  consignor_id: number;
  sold_share: string;
  loss_compensation: string;
  payout_due: string;
  created_at: string;
}

interface FinancialRow extends RowDataPacket {
  consignor_id: number;
  consignor_name: string;
  phone: string | null;
  is_active: number;
  total_accrual: string;
  total_payment: string;
}

function mapPaymentRowToEntity(row: PaymentRow): ConsignorPaymentEntity {
  return {
    id: row.id,
    consignorId: Number(row.consignor_id),
    consignorName: row.consignor_name,
    opnameId: row.opname_id === null ? null : Number(row.opname_id),
    opnameDate: row.opname_date,
    amount: String(row.amount),
    paymentDate: row.payment_date,
    paymentMethod: row.payment_method,
    note: row.note,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdByUsername: row.created_by_username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PayoutRepository {
  async createPayment(data: CreatePaymentData, db: Db): Promise<ConsignorPaymentEntity> {
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO consignor_payments (
         consignor_id,
         opname_id,
         amount,
         payment_date,
         payment_method,
         note,
         created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.consignorId,
        data.opnameId ?? null,
        data.amount,
        data.paymentDate,
        data.paymentMethod,
        data.note ?? null,
        data.createdBy ?? null,
      ],
    );

    const insertedId = result.insertId;
    const created = await this.findPaymentById(insertedId, db);
    if (!created) {
      throw new Error(`Gagal memuat bukti pembayaran yang baru dibuat dengan ID ${insertedId}`);
    }
    return created;
  }

  async findPaymentById(id: number, db: Db): Promise<ConsignorPaymentEntity | null> {
    const [rows] = await db.execute<PaymentRow[]>(
      `SELECT
         cp.id,
         cp.consignor_id,
         c.name AS consignor_name,
         cp.opname_id,
         DATE_FORMAT(o.opname_date, '%Y-%m-%d') AS opname_date,
         cp.amount,
         DATE_FORMAT(cp.payment_date, '%Y-%m-%d') AS payment_date,
         cp.payment_method,
         cp.note,
         cp.created_by,
         u.username AS created_by_username,
         DATE_FORMAT(cp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(cp.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM consignor_payments cp
       JOIN consignors c ON c.id = cp.consignor_id
       LEFT JOIN opnames o ON o.id = cp.opname_id
       LEFT JOIN users u ON u.id = cp.created_by
       WHERE cp.id = ?`,
      [id],
    );

    const row = rows[0];
    return row ? mapPaymentRowToEntity(row) : null;
  }

  async listPayments(
    options: ListPaymentsOptions,
    db: Db,
  ): Promise<{ data: ConsignorPaymentEntity[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.consignorId) {
      conditions.push('cp.consignor_id = ?');
      params.push(options.consignorId);
    }

    if (options.opnameId) {
      conditions.push('cp.opname_id = ?');
      params.push(options.opnameId);
    }

    if (options.startDate) {
      conditions.push('cp.payment_date >= ?');
      params.push(options.startDate);
    }

    if (options.endDate) {
      conditions.push('cp.payment_date <= ?');
      params.push(options.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `
      SELECT COUNT(*) AS total
      FROM consignor_payments cp
      ${whereClause}
    `;

    const [countRows] = await db.execute<RowDataPacket[]>(countSql, params);
    const total = Number(countRows[0]?.total ?? 0);

    const page = Math.max(1, options.page);
    const limit = Math.max(1, Math.min(100, options.limit));
    const offset = (page - 1) * limit;

    const selectSql = `
      SELECT
        cp.id,
        cp.consignor_id,
        c.name AS consignor_name,
        cp.opname_id,
        DATE_FORMAT(o.opname_date, '%Y-%m-%d') AS opname_date,
        cp.amount,
        DATE_FORMAT(cp.payment_date, '%Y-%m-%d') AS payment_date,
        cp.payment_method,
        cp.note,
        cp.created_by,
        u.username AS created_by_username,
        DATE_FORMAT(cp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(cp.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
      FROM consignor_payments cp
      JOIN consignors c ON c.id = cp.consignor_id
      LEFT JOIN opnames o ON o.id = cp.opname_id
      LEFT JOIN users u ON u.id = cp.created_by
      ${whereClause}
      ORDER BY cp.payment_date DESC, cp.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await db.execute<PaymentRow[]>(selectSql, params);
    const data = rows.map(mapPaymentRowToEntity);

    return { data, total };
  }

  async deletePayment(id: number, db: Db): Promise<void> {
    await db.execute('DELETE FROM consignor_payments WHERE id = ?', [id]);
  }

  async getAccrualsByConsignor(consignorId: number, db: Db): Promise<ConsignorAccrualRow[]> {
    const [rows] = await db.execute<AccrualRow[]>(
      `SELECT
         ocp.id,
         ocp.opname_id,
         DATE_FORMAT(o.opname_date, '%Y-%m-%d') AS opname_date,
         ocp.consignor_id,
         ocp.sold_share,
         ocp.loss_compensation,
         ocp.payout_due,
         DATE_FORMAT(ocp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM opname_consignor_payouts ocp
       JOIN opnames o ON o.id = ocp.opname_id
       WHERE ocp.consignor_id = ? AND o.status = 'final'
       ORDER BY o.opname_date ASC, ocp.id ASC`,
      [consignorId],
    );

    return rows.map((r) => ({
      id: r.id,
      opnameId: Number(r.opname_id),
      opnameDate: r.opname_date,
      consignorId: Number(r.consignor_id),
      soldShare: String(r.sold_share),
      lossCompensation: String(r.loss_compensation),
      payoutDue: String(r.payout_due),
      createdAt: r.created_at,
    }));
  }

  async getPaymentsByConsignor(consignorId: number, db: Db): Promise<ConsignorPaymentEntity[]> {
    const [rows] = await db.execute<PaymentRow[]>(
      `SELECT
         cp.id,
         cp.consignor_id,
         c.name AS consignor_name,
         cp.opname_id,
         DATE_FORMAT(o.opname_date, '%Y-%m-%d') AS opname_date,
         cp.amount,
         DATE_FORMAT(cp.payment_date, '%Y-%m-%d') AS payment_date,
         cp.payment_method,
         cp.note,
         cp.created_by,
         u.username AS created_by_username,
         DATE_FORMAT(cp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         DATE_FORMAT(cp.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM consignor_payments cp
       JOIN consignors c ON c.id = cp.consignor_id
       LEFT JOIN opnames o ON o.id = cp.opname_id
       LEFT JOIN users u ON u.id = cp.created_by
       WHERE cp.consignor_id = ?
       ORDER BY cp.payment_date ASC, cp.id ASC`,
      [consignorId],
    );

    return rows.map(mapPaymentRowToEntity);
  }

  async getAllConsignorsWithFinancials(db: Db): Promise<ConsignorFinancialRow[]> {
    const [rows] = await db.execute<FinancialRow[]>(
      `SELECT
         c.id AS consignor_id,
         c.name AS consignor_name,
         c.phone,
         c.is_active,
         COALESCE(acc.total_accrual, '0.0000') AS total_accrual,
         COALESCE(pay.total_payment, '0.0000') AS total_payment
       FROM consignors c
       LEFT JOIN (
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
       ORDER BY c.name ASC`,
    );

    return rows.map((r) => ({
      consignorId: Number(r.consignor_id),
      consignorName: r.consignor_name,
      phone: r.phone,
      isActive: Boolean(r.is_active),
      totalAccrual: String(r.total_accrual),
      totalPayment: String(r.total_payment),
    }));
  }
}

export const payoutRepository = new PayoutRepository();
