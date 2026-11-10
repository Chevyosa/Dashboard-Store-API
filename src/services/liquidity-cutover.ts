import type { Pool, PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { parseMoney, toDbString } from '../domain/money.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import {
  isAfterCutoverDate,
  isAtOrBelowHighWater,
  LiquidityRepository,
  type LiquidityCutoverEntity,
} from '../repositories/liquidity.repository.js';
import { AppError } from '../utils/errors.js';
import { systemClock, toMysqlUtc, type Clock } from '../utils/time.js';
import type { InitializeCutoverInput } from '../validators/liquidity-cutover.js';

/**
 * Rejects a source write dated on or before the cutover calendar date. Those
 * days are already reflected in the opening balance, so a new or moved
 * transaction there would be counted twice (or silently left out of the ledger).
 * No-op while the cutover does not exist.
 */
export function assertAfterCutover(
  cutover: LiquidityCutoverEntity | null,
  date: string,
  subject: string,
): void {
  if (cutover && !isAfterCutoverDate(cutover, date)) {
    throw new AppError(
      409,
      'BEFORE_LIQUIDITY_CUTOVER',
      `${subject} bertanggal ${date} tidak dapat diproses karena tanggal tersebut tidak setelah tanggal cutover saldo (${cutover.cutoverAt.slice(0, 10)}).`,
    );
  }
}

/**
 * Rejects changing a source row that already existed when the cutover was taken
 * (id at or below `highWaterId`), whatever its business date. Its effect is
 * already in the opening balance, so changing it now would corrupt the ledger.
 * No-op while the cutover does not exist.
 */
export function assertNotPreCutoverSource(
  cutover: LiquidityCutoverEntity | null,
  highWaterId: (cutover: LiquidityCutoverEntity) => string,
  sourceId: string | number,
  subject: string,
): void {
  if (cutover && isAtOrBelowHighWater(sourceId, highWaterId(cutover))) {
    throw new AppError(
      409,
      'BEFORE_LIQUIDITY_CUTOVER',
      `${subject} (ID ${String(sourceId)}) sudah tercatat sebelum cutover saldo (${cutover.cutoverAt.slice(0, 10)}) dan tidak dapat diproses lagi.`,
    );
  }
}

export interface LiquidityCutoverServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

// Deadlocks are expected when two initializations race: both hold the gap
// lock on the missing row and both try to insert it. InnoDB rolls one back;
// its retry then blocks on the winner's row and reports 409.
const MAX_ATTEMPTS = 3;

function alreadyInitialized(): AppError {
  return new AppError(
    409,
    'LIQUIDITY_CUTOVER_ALREADY_INITIALIZED',
    'Cutover saldo sudah pernah dilakukan dan tidak dapat diulang.',
  );
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

export function createLiquidityCutoverService({ pool, clock = systemClock }: LiquidityCutoverServiceDeps) {
  const liquidityRepo = new LiquidityRepository();

  async function initializeWithinLock(
    conn: PoolConnection,
    userId: number,
    input: InitializeCutoverInput,
    meta: AuditMeta | undefined,
  ): Promise<LiquidityCutoverEntity> {
    // The common lock every source write takes first.
    if (await liquidityRepo.lockCutoverForUpdate(conn)) throw alreadyInitialized();

    const cutoverAt = toMysqlUtc(clock());
    const openingAmount = toDbString(parseMoney(input.openingAmount));
    const openingUnpaidStock = toDbString(parseMoney(input.openingUnpaidStock));

    // The locking read above already holds the exclusive id=1 lock. If the row
    // was absent, that is an exclusive InnoDB gap lock; every source write takes
    // the same lock before it mutates a source table. Thus all earlier writes
    // have committed before this point, and this insert keeps later writes
    // blocked until the transaction commits. The first consistent read below
    // then captures the complete pre-cutover high-water marks.
    await conn.execute(
      `INSERT INTO liquidity_cutover (
         id, opening_amount, opening_unpaid_stock, cutover_at,
         opname_high_water_id, stock_in_high_water_id, stock_in_payment_high_water_id,
         consignor_payment_high_water_id, take_profit_high_water_id, created_by
       ) VALUES (1, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
      [openingAmount, openingUnpaidStock, cutoverAt, userId],
    );

    // A draft would sit at or below the opname high-water mark and could never
    // be finalized afterwards. Checked after the insert, so drafts saved by
    // in-flight writes (which hold the common lock) are visible; throwing rolls
    // the insert back, so a refusal writes nothing.
    if (await liquidityRepo.hasDraftOpname(conn)) {
      throw new AppError(
        409,
        'LIQUIDITY_CUTOVER_HAS_OPEN_OPNAMES',
        'Cutover saldo tidak dapat dilakukan karena masih ada opname berstatus draft. Finalisasi atau selesaikan draft tersebut terlebih dahulu.',
      );
    }

    // First consistent read of this transaction, so its snapshot postdates the
    // insert above and includes every source write it waited for.
    const hw = await liquidityRepo.getSourceHighWaterIds(conn);
    await conn.execute(
      `UPDATE liquidity_cutover SET
         opname_high_water_id = CAST(? AS UNSIGNED),
         stock_in_high_water_id = CAST(? AS UNSIGNED),
         stock_in_payment_high_water_id = CAST(? AS UNSIGNED),
         consignor_payment_high_water_id = CAST(? AS UNSIGNED),
         take_profit_high_water_id = CAST(? AS UNSIGNED)
       WHERE id = 1`,
      [
        hw.opnameHighWaterId,
        hw.stockInHighWaterId,
        hw.stockInPaymentHighWaterId,
        hw.consignorPaymentHighWaterId,
        hw.takeProfitHighWaterId,
      ],
    );

    const cutover = await liquidityRepo.findCutover(conn);
    if (!cutover) throw new Error('liquidity_cutover row missing right after insert');

    // Seeds the ledger with physical cash only; opening_unpaid_stock is a
    // liability and never becomes an event. No historical sources are backfilled.
    const openingEventId = await liquidityRepo.appendEvent(
      {
        eventType: 'opening',
        sourceType: 'cutover',
        sourceId: '1',
        amountDelta: cutover.openingAmount,
        effectiveDate: cutover.cutoverAt.slice(0, 10),
        createdBy: userId,
      },
      conn,
    );

    await insertAuditEntry(conn, {
      userId,
      action: 'liquidity.cutover_initialized',
      entityType: 'liquidity_cutover',
      entityId: '1',
      after: { ...cutover, openingEventId },
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
      at: clock(),
    });

    return cutover;
  }

  return {
    async initializeCutover(
      userId: number,
      input: InitializeCutoverInput,
      meta?: AuditMeta,
    ): Promise<LiquidityCutoverEntity> {
      for (let attempt = 1; ; attempt++) {
        try {
          return await withTransaction(pool, (conn) => initializeWithinLock(conn, userId, input, meta));
        } catch (err) {
          const code = errorCode(err);
          if (code === 'ER_DUP_ENTRY') throw alreadyInitialized();
          if (code === 'ER_LOCK_DEADLOCK' && attempt < MAX_ATTEMPTS) continue;
          throw err;
        }
      }
    },
  };
}
