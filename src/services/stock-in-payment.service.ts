import type { Pool, PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { compareMoney, parseMoney, subMoney, toDbString, ZERO_MONEY } from '../domain/money.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import { LiquidityRepository } from '../repositories/liquidity.repository.js';
import { StockInRepository } from '../repositories/stock-in.repository.js';
import {
  StockInPaymentRepository,
  type StockInPaymentEntity,
} from '../repositories/stock-in-payment.repository.js';
import { AppError } from '../utils/errors.js';
import { assertAfterCutover } from './liquidity-cutover.js';
import { systemClock, type Clock } from '../utils/time.js';
import type { CreateStockInPaymentInput } from '../validators/stock-in-payment.js';

export interface StockInPaymentServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface RecordPaymentResult {
  payment: StockInPaymentEntity;
  /** true when an earlier request with the same Idempotency-Key is being replayed. */
  replayed: boolean;
}

export interface StockInPaymentHistory {
  stockInId: number;
  receiptTotal: string;
  paidAmount: string;
  outstandingAmount: string;
  payments: StockInPaymentEntity[];
}

interface NormalizedPayment {
  stockInId: number;
  amount: string;
  paymentDate: string;
  paymentMethod: CreateStockInPaymentInput['paymentMethod'];
  note: string | null;
}

function normalize(stockInId: number, input: CreateStockInPaymentInput): NormalizedPayment {
  return {
    stockInId,
    amount: toDbString(parseMoney(input.amount)),
    paymentDate: input.paymentDate,
    paymentMethod: input.paymentMethod,
    note: input.note ? input.note : null,
  };
}

function samePayload(existing: StockInPaymentEntity, req: NormalizedPayment): boolean {
  return (
    existing.stockInId === req.stockInId &&
    compareMoney(existing.amount, req.amount) === 0 &&
    existing.paymentDate === req.paymentDate &&
    existing.paymentMethod === req.paymentMethod &&
    existing.note === req.note
  );
}

function resolveReplay(existing: StockInPaymentEntity, req: NormalizedPayment): RecordPaymentResult {
  if (!samePayload(existing, req)) {
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_MISMATCH',
      'Idempotency-Key sudah dipakai untuk pembayaran dengan data berbeda.',
    );
  }
  return { payment: existing, replayed: true };
}

function isIdempotencyKeyConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === 'ER_DUP_ENTRY' &&
    typeof e.message === 'string' &&
    e.message.includes('uq_stock_in_payments_idempotency_key')
  );
}

function notFound(id: number): AppError {
  return new AppError(404, 'STOCK_IN_NOT_FOUND', `Data barang masuk dengan ID ${id} tidak ditemukan.`);
}

function notPurchase(): AppError {
  return new AppError(
    400,
    'STOCK_IN_NOT_PURCHASE',
    'Pembayaran hanya dapat dicatat untuk barang masuk bertipe belanja (purchase).',
  );
}

export function createStockInPaymentService({ pool, clock = systemClock }: StockInPaymentServiceDeps) {
  const paymentRepo = new StockInPaymentRepository();
  const liquidityRepo = new LiquidityRepository();
  const stockInRepo = new StockInRepository();

  async function insertWithinLock(
    conn: PoolConnection,
    userId: number,
    key: string,
    req: NormalizedPayment,
    meta: AuditMeta | undefined,
  ): Promise<RecordPaymentResult> {
    // Common cutover lock first (same order as every other source write), so
    // this payment can never land on the wrong side of a concurrent cutover.
    const cutover = await liquidityRepo.lockCutoverForUpdate(conn);

    // Serializes all payments (and stock-in edits) for this receipt.
    const stockIn = await paymentRepo.lockStockIn(req.stockInId, conn);
    if (!stockIn) throw notFound(req.stockInId);

    // Recheck after the locks: a concurrent duplicate may have committed while
    // we waited. Both locks were locking reads, so this is the transaction's
    // first consistent read and its snapshot already includes that commit.
    const raced = await paymentRepo.findByIdempotencyKey(key, conn);
    if (raced) return resolveReplay(raced, req);

    if (stockIn.type !== 'purchase') throw notPurchase();
    assertAfterCutover(cutover, req.paymentDate, 'Pembayaran barang masuk');

    const { receiptTotal, paidAmount } = await paymentRepo.getTotals(stockIn.id, conn);
    const outstanding = subMoney(receiptTotal, paidAmount);
    if (compareMoney(req.amount, outstanding) > 0) {
      throw new AppError(
        409,
        'PAYMENT_EXCEEDS_OUTSTANDING',
        `Nominal pembayaran melebihi sisa tagihan barang masuk (${toDbString(
          outstanding.isNegative() ? ZERO_MONEY : outstanding,
        )}).`,
      );
    }

    const payment = await paymentRepo.create({ ...req, idempotencyKey: key, createdBy: userId }, conn);

    // Before cutover the future opening balance absorbs this outflow, so only a
    // post-cutover payment (already checked to be dated after the cutoff)
    // becomes a ledger movement. Reserve is intentionally
    // not checked: this is an actual settlement, not an owner withdrawal.
    let liquidityEventId: number | null = null;
    if (cutover) {
      liquidityEventId = await liquidityRepo.appendEvent(
        {
          eventType: 'stock_payment',
          sourceType: 'stock_in_payment',
          sourceId: String(payment.id),
          amountDelta: toDbString(parseMoney(payment.amount).negated()),
          effectiveDate: payment.paymentDate,
          createdBy: userId,
        },
        conn,
      );
    }

    await insertAuditEntry(conn, {
      userId,
      action: 'stock_in_payment.created',
      entityType: 'stock_in_payment',
      entityId: String(payment.id),
      after: { ...payment, liquidityEventId },
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
      at: clock(),
    });

    return { payment, replayed: false };
  }

  return {
    async recordPayment(
      userId: number,
      stockInId: number,
      idempotencyKey: string,
      input: CreateStockInPaymentInput,
      meta?: AuditMeta,
    ): Promise<RecordPaymentResult> {
      const req = normalize(stockInId, input);

      // Fast path for plain retries: no lock needed.
      const existing = await paymentRepo.findByIdempotencyKey(idempotencyKey, pool);
      if (existing) return resolveReplay(existing, req);

      try {
        return await withTransaction(pool, (conn) =>
          insertWithinLock(conn, userId, idempotencyKey, req, meta),
        );
      } catch (err) {
        // Same key racing on a *different* stock-in is not serialized by the row
        // lock; the unique index catches it and the committed winner decides.
        if (isIdempotencyKeyConflict(err)) {
          const winner = await paymentRepo.findByIdempotencyKey(idempotencyKey, pool);
          if (winner) return resolveReplay(winner, req);
        }
        throw err;
      }
    },

    async getPaymentHistory(stockInId: number): Promise<StockInPaymentHistory> {
      // One transaction so totals and the list come from the same snapshot.
      return withTransaction(pool, async (conn) => {
        const stockIn = await stockInRepo.findById(stockInId, conn);
        if (!stockIn) throw notFound(stockInId);
        if (stockIn.type !== 'purchase') throw notPurchase();

        const { receiptTotal, paidAmount } = await paymentRepo.getTotals(stockInId, conn);
        const payments = await paymentRepo.listByStockIn(stockInId, conn);
        const outstanding = subMoney(receiptTotal, paidAmount);
        return {
          stockInId,
          receiptTotal: toDbString(receiptTotal),
          paidAmount: toDbString(paidAmount),
          outstandingAmount: toDbString(outstanding.isNegative() ? ZERO_MONEY : outstanding),
          payments,
        };
      });
    },
  };
}
