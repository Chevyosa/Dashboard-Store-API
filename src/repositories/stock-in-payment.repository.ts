import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type Db = Pool | PoolConnection;

export type StockInPaymentMethod = 'cash' | 'transfer' | 'qris';

export interface StockInPaymentEntity {
  id: number;
  stockInId: number;
  amount: string;
  paymentDate: string;
  paymentMethod: StockInPaymentMethod;
  note: string | null;
  idempotencyKey: string;
  createdBy: number | null;
  createdAt: string;
}

export interface CreateStockInPaymentData {
  stockInId: number;
  amount: string;
  paymentDate: string;
  paymentMethod: StockInPaymentMethod;
  note: string | null;
  idempotencyKey: string;
  createdBy: number;
}

export interface LockedStockIn {
  id: number;
  type: 'purchase' | 'consignment_in' | 'initial';
  opnameId: number | null;
}

interface PaymentRow extends RowDataPacket {
  id: number;
  stock_in_id: number;
  amount: string;
  payment_date: string;
  payment_method: StockInPaymentMethod;
  note: string | null;
  idempotency_key: string;
  created_by: number | null;
  created_at: string;
}

const SELECT_PAYMENT = `
  SELECT
    id,
    stock_in_id,
    amount,
    DATE_FORMAT(payment_date, '%Y-%m-%d') AS payment_date,
    payment_method,
    note,
    idempotency_key,
    created_by,
    DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
  FROM stock_in_payments`;

function mapRow(row: PaymentRow): StockInPaymentEntity {
  return {
    id: Number(row.id),
    stockInId: Number(row.stock_in_id),
    amount: String(row.amount),
    paymentDate: row.payment_date,
    paymentMethod: row.payment_method,
    note: row.note,
    idempotencyKey: row.idempotency_key,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    // DATETIME(3): trim %f's six digits to the stored millisecond precision.
    createdAt: String(row.created_at).slice(0, 23),
  };
}

export class StockInPaymentRepository {
  /**
   * Takes an exclusive row lock on the stock-in. Every payment insert and every
   * stock-in update/delete goes through this lock, so they serialize per receipt.
   */
  async lockStockIn(id: number, conn: PoolConnection): Promise<LockedStockIn | null> {
    const [rows] = await conn.execute<RowDataPacket[]>(
      'SELECT id, type, opname_id FROM stock_ins WHERE id = ? FOR UPDATE',
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      type: row.type as LockedStockIn['type'],
      opnameId: row.opname_id === null ? null : Number(row.opname_id),
    };
  }

  async findByIdempotencyKey(key: string, db: Db): Promise<StockInPaymentEntity | null> {
    const [rows] = await db.execute<PaymentRow[]>(`${SELECT_PAYMENT} WHERE idempotency_key = ?`, [
      key,
    ]);
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async findById(id: number, db: Db): Promise<StockInPaymentEntity | null> {
    const [rows] = await db.execute<PaymentRow[]>(`${SELECT_PAYMENT} WHERE id = ?`, [id]);
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async listByStockIn(stockInId: number, db: Db): Promise<StockInPaymentEntity[]> {
    const [rows] = await db.execute<PaymentRow[]>(
      `${SELECT_PAYMENT} WHERE stock_in_id = ? ORDER BY payment_date ASC, id ASC`,
      [stockInId],
    );
    return rows.map(mapRow);
  }

  /** Receipt total (sum of line costs) and paid total for one stock-in, as exact decimal strings. */
  async getTotals(stockInId: number, db: Db): Promise<{ receiptTotal: string; paidAmount: string }> {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         (SELECT CAST(COALESCE(SUM(total_cost), 0) AS DECIMAL(42,4))
            FROM stock_in_lines WHERE stock_in_id = ?) AS receipt_total,
         (SELECT CAST(COALESCE(SUM(amount), 0) AS DECIMAL(42,4))
            FROM stock_in_payments WHERE stock_in_id = ?) AS paid_amount`,
      [stockInId, stockInId],
    );
    return {
      receiptTotal: String(rows[0]?.receipt_total ?? '0.0000'),
      paidAmount: String(rows[0]?.paid_amount ?? '0.0000'),
    };
  }

  async hasPayments(stockInId: number, db: Db): Promise<boolean> {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT 1 FROM stock_in_payments WHERE stock_in_id = ? LIMIT 1',
      [stockInId],
    );
    return rows.length > 0;
  }

  async create(data: CreateStockInPaymentData, conn: PoolConnection): Promise<StockInPaymentEntity> {
    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT INTO stock_in_payments
         (stock_in_id, amount, payment_date, payment_method, note, idempotency_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.stockInId,
        data.amount,
        data.paymentDate,
        data.paymentMethod,
        data.note,
        data.idempotencyKey,
        data.createdBy,
      ],
    );
    const created = await this.findById(result.insertId, conn);
    if (!created) {
      throw new Error(`Gagal memuat pembayaran barang masuk dengan id ${result.insertId}`);
    }
    return created;
  }
}

export const stockInPaymentRepository = new StockInPaymentRepository();
