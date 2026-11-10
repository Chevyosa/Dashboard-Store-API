import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export type Db = Pool | PoolConnection;

export type LiquidityEventType =
  | 'opening'
  | 'opname_inflow'
  | 'stock_payment'
  | 'consignor_payment'
  | 'owner_withdrawal'
  | 'reversal';

export type LiquiditySourceType =
  | 'cutover'
  | 'opname'
  | 'stock_in_payment'
  | 'consignor_payment'
  | 'take_profit';

/** Event/source pairs allowed by chk_liquidity_events_source_match (migration 0013). */
export type LiquidityEventKind =
  | { eventType: 'opening'; sourceType: 'cutover' }
  | { eventType: 'opname_inflow'; sourceType: 'opname' }
  | { eventType: 'stock_payment'; sourceType: 'stock_in_payment' }
  | { eventType: 'consignor_payment'; sourceType: 'consignor_payment' }
  | { eventType: 'owner_withdrawal'; sourceType: 'take_profit' }
  | { eventType: 'reversal'; sourceType: Exclude<LiquiditySourceType, 'cutover'> };

export type AppendLiquidityEventData = LiquidityEventKind & {
  /** BIGINT UNSIGNED id in the table named by sourceType, as a decimal-digit string. */
  sourceId: string;
  /** Signed DECIMAL(20,4) string; the sign is enforced by chk_liquidity_events_sign. */
  amountDelta: string;
  /** YYYY-MM-DD */
  effectiveDate: string;
  createdBy?: number | null | undefined;
};

/**
 * Synthetic entity key for supplier debt carried over from before the cutover
 * (`opening_unpaid_stock`). Non-numeric, so it can never collide with a
 * stock_ins.id key.
 */
export const LEGACY_STOCK_ENTITY_ID = 'legacy-opening-stock';

export interface LiquidityCutoverEntity {
  /**
   * Actual liquid cash on hand at cutover (DECIMAL string). Seeds the cash
   * ledger's 'opening' event; it is not net of any debt.
   */
  openingAmount: string;
  /**
   * Outstanding supplier debt at cutover for legacy purchase receipts
   * (DECIMAL string). An obligation, not cash: it never enters the ledger.
   */
  openingUnpaidStock: string;
  cutoverAt: string;
  /** BIGINT UNSIGNED watermarks are kept as strings so they never lose precision. */
  opnameHighWaterId: string;
  stockInHighWaterId: string;
  /** stock_in_payments rows at or below this id are already reflected in openingUnpaidStock. */
  stockInPaymentHighWaterId: string;
  consignorPaymentHighWaterId: string;
  takeProfitHighWaterId: string;
  createdBy: number | null;
  createdAt: string;
}

export type SourceHighWaterIds = Pick<
  LiquidityCutoverEntity,
  | 'opnameHighWaterId'
  | 'stockInHighWaterId'
  | 'stockInPaymentHighWaterId'
  | 'consignorPaymentHighWaterId'
  | 'takeProfitHighWaterId'
>;

/**
 * Accrued/paid totals keyed by stable entity id (string). Shape matches
 * `PerEntityObligationsInput`, so it can be passed to `sumUnpaidPerEntity`.
 */
export interface PerEntityTotals {
  accrued: Map<string, string>;
  paid: Map<string, string>;
}

interface CutoverRow extends RowDataPacket {
  opening_amount: string;
  opening_unpaid_stock: string;
  cutover_at: string;
  opname_high_water_id: string;
  stock_in_high_water_id: string;
  stock_in_payment_high_water_id: string;
  consignor_payment_high_water_id: string;
  take_profit_high_water_id: string;
  created_by: number | null;
  created_at: string;
}

interface EntityAmountRow extends RowDataPacket {
  entity_id: string;
  amount: string;
}

const UNSIGNED_ID_PATTERN = /^(?:0|[1-9]\d{0,19})$/;
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;

function assertUnsignedId(value: string, label: string): void {
  if (!UNSIGNED_ID_PATTERN.test(value) || BigInt(value) > MAX_UNSIGNED_BIGINT) {
    throw new Error(`${label} harus berupa BIGINT UNSIGNED valid, diterima "${value}"`);
  }
}

function toEntityMap(rows: EntityAmountRow[]): Map<string, string> {
  return new Map(rows.map((r) => [String(r.entity_id), String(r.amount)]));
}

// BIGINT columns are CAST to CHAR: the pool has no bigNumberStrings, so
// values above 2^53 would otherwise come back as lossy JS numbers.
const SELECT_CUTOVER = `
  SELECT
    id,
    opening_amount,
    opening_unpaid_stock,
    DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s.%f') AS cutover_at,
    CAST(opname_high_water_id AS CHAR) AS opname_high_water_id,
    CAST(stock_in_high_water_id AS CHAR) AS stock_in_high_water_id,
    CAST(stock_in_payment_high_water_id AS CHAR) AS stock_in_payment_high_water_id,
    CAST(consignor_payment_high_water_id AS CHAR) AS consignor_payment_high_water_id,
    CAST(take_profit_high_water_id AS CHAR) AS take_profit_high_water_id,
    created_by,
    DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
  FROM liquidity_cutover
  WHERE id = 1`;

function mapCutoverRow(row: CutoverRow): LiquidityCutoverEntity {
  return {
    openingAmount: String(row.opening_amount),
    openingUnpaidStock: String(row.opening_unpaid_stock),
    // DATETIME(3): trim %f's six digits back to the stored millisecond precision.
    cutoverAt: String(row.cutover_at).slice(0, 23),
    opnameHighWaterId: String(row.opname_high_water_id),
    stockInHighWaterId: String(row.stock_in_high_water_id),
    stockInPaymentHighWaterId: String(row.stock_in_payment_high_water_id),
    consignorPaymentHighWaterId: String(row.consignor_payment_high_water_id),
    takeProfitHighWaterId: String(row.take_profit_high_water_id),
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdAt: row.created_at,
  };
}

/**
 * Whether a business date (YYYY-MM-DD) falls strictly after the calendar date
 * of the cutover. The cutover day itself belongs to the pre-cutover period,
 * since its opening balance already reflects that day's activity.
 */
export function isAfterCutoverDate(cutover: LiquidityCutoverEntity, date: string): boolean {
  // Both sides are zero-padded YYYY-MM-DD, so lexical order is calendar order.
  return date > cutover.cutoverAt.slice(0, 10);
}

const POSITIVE_ID_PATTERN = /^[1-9]\d{0,19}$/;

function toPositiveIdBigInt(value: string | number): bigint {
  let parsed: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`sourceId harus berupa bilangan bulat positif, diterima "${String(value)}"`);
    }
    parsed = BigInt(value);
  } else {
    if (!POSITIVE_ID_PATTERN.test(value)) {
      throw new Error(`sourceId harus berupa bilangan bulat positif, diterima "${String(value)}"`);
    }
    parsed = BigInt(value);
  }
  if (parsed > MAX_UNSIGNED_BIGINT) {
    throw new Error(`sourceId melampaui BIGINT UNSIGNED, diterima "${String(value)}"`);
  }
  return parsed;
}

/**
 * Whether a source row id is at or below a cutover high-water id, i.e. the row
 * already existed when the cutover was taken. Compared as BigInt so BIGINT
 * UNSIGNED ids above 2^53 never lose precision; ids are never converted to Number.
 * `sourceId` must be a positive integer (a safe-integer number or a canonical
 * decimal string); `highWaterId` a non-negative decimal string.
 */
export function isAtOrBelowHighWater(sourceId: string | number, highWaterId: string): boolean {
  const source = toPositiveIdBigInt(sourceId);
  assertUnsignedId(highWaterId, 'highWaterId');
  return source <= BigInt(highWaterId);
}

export class LiquidityRepository {
  /** Reads the singleton cutover snapshot, or null before the ledger is initialized. */
  async findCutover(db: Db): Promise<LiquidityCutoverEntity | null> {
    const [rows] = await db.execute<CutoverRow[]>(SELECT_CUTOVER);
    const row = rows[0];
    return row ? mapCutoverRow(row) : null;
  }

  /**
   * The common cutover lock every liquidity source write takes first, inside
   * its transaction. Exclusive, so source writes serialize with each other.
   * With no cutover row yet, InnoDB takes a gap lock on id = 1 instead, which
   * blocks the one-time cutover insert until this transaction ends, so a source
   * write is never left on the wrong side of the cutover.
   */
  async lockCutoverForUpdate(conn: PoolConnection): Promise<LiquidityCutoverEntity | null> {
    const [rows] = await conn.execute<CutoverRow[]>(`${SELECT_CUTOVER} FOR UPDATE`);
    const row = rows[0];
    return row ? mapCutoverRow(row) : null;
  }

  /**
   * Highest existing id of every liquidity source table, as decimal strings
   * ('0' for an empty table). Plain (snapshot) reads: the cutover calls this
   * only after its own insert has waited out every source write holding the
   * common lock, so the transaction's first consistent read sees all of them.
   */
  async getSourceHighWaterIds(db: Db): Promise<SourceHighWaterIds> {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         (SELECT CAST(COALESCE(MAX(id), 0) AS CHAR) FROM opnames) AS opname_hw,
         (SELECT CAST(COALESCE(MAX(id), 0) AS CHAR) FROM stock_ins) AS stock_in_hw,
         (SELECT CAST(COALESCE(MAX(id), 0) AS CHAR) FROM stock_in_payments) AS stock_in_payment_hw,
         (SELECT CAST(COALESCE(MAX(id), 0) AS CHAR) FROM consignor_payments) AS consignor_payment_hw,
         (SELECT CAST(COALESCE(MAX(id), 0) AS CHAR) FROM take_profits) AS take_profit_hw`,
    );
    const row = rows[0];
    return {
      opnameHighWaterId: String(row?.opname_hw ?? '0'),
      stockInHighWaterId: String(row?.stock_in_hw ?? '0'),
      stockInPaymentHighWaterId: String(row?.stock_in_payment_hw ?? '0'),
      consignorPaymentHighWaterId: String(row?.consignor_payment_hw ?? '0'),
      takeProfitHighWaterId: String(row?.take_profit_hw ?? '0'),
    };
  }

  /**
   * Whether any draft opname exists. A locking read: it sees the latest
   * committed rows and blocks concurrent changes to them until the caller's
   * transaction ends.
   */
  async hasDraftOpname(conn: PoolConnection): Promise<boolean> {
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT id FROM opnames WHERE status = 'draft' LIMIT 1 FOR SHARE`,
    );
    return rows.length > 0;
  }

  /**
   * Liquid cash balance = SUM(amount_delta) over the whole ledger, as an exact
   * decimal string. Cash only: outstanding obligations are not netted here.
   */
  async sumEventBalance(db: Db): Promise<string> {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT CAST(COALESCE(SUM(amount_delta), 0) AS DECIMAL(42,4)) AS balance
       FROM liquidity_events`,
    );
    return String(rows[0]?.balance ?? '0.0000');
  }

  /**
   * All-time finalized consignor accruals and recorded payments, grouped by
   * consignor. Totals are not netted here: callers floor unpaid per consignor
   * (sumUnpaidPerEntity) so one consignor's overpayment cannot hide another's debt.
   */
  async getConsignorObligationTotals(db: Db): Promise<PerEntityTotals> {
    const [accruedRows] = await db.execute<EntityAmountRow[]>(
      `SELECT
         CAST(ocp.consignor_id AS CHAR) AS entity_id,
         SUM(ocp.payout_due) AS amount
       FROM opname_consignor_payouts ocp
       JOIN opnames o ON o.id = ocp.opname_id
       WHERE o.status = 'final'
       GROUP BY ocp.consignor_id
       ORDER BY ocp.consignor_id ASC`,
    );
    const [paidRows] = await db.execute<EntityAmountRow[]>(
      `SELECT
         CAST(cp.consignor_id AS CHAR) AS entity_id,
         SUM(cp.amount) AS amount
       FROM consignor_payments cp
       GROUP BY cp.consignor_id
       ORDER BY cp.consignor_id ASC`,
    );
    return { accrued: toEntityMap(accruedRows), paid: toEntityMap(paidRows) };
  }

  /**
   * Outstanding supplier debt for purchase stock-ins (`stock_ins.type =
   * 'purchase'`; consignment_in / initial never owe a supplier), split into:
   *
   * - LEGACY_STOCK_ENTITY_ID: accrued = `cutover.openingUnpaidStock`, the
   *   explicit opening liability for receipts at or below stockInHighWaterId;
   *   paid = post-cutover payments against those legacy receipts. Their own
   *   line costs are never counted, since their settlement status predates
   *   this ledger and is captured only by that opening figure.
   * - one entity per receipt above stockInHighWaterId: accrued = SUM(line
   *   total_cost), paid = its post-cutover payments.
   *
   * Payments at or below stockInPaymentHighWaterId are historical: they are
   * already reflected in openingUnpaidStock and are never subtracted again.
   * Totals are not netted: callers floor per entity (sumUnpaidPerEntity), so
   * an overpaid legacy balance cannot hide debt on a new receipt.
   */
  async getPurchaseStockObligationTotals(
    cutover: LiquidityCutoverEntity,
    db: Db,
  ): Promise<PerEntityTotals> {
    const { stockInHighWaterId, stockInPaymentHighWaterId } = cutover;
    assertUnsignedId(stockInHighWaterId, 'stockInHighWaterId');
    assertUnsignedId(stockInPaymentHighWaterId, 'stockInPaymentHighWaterId');

    // CAST(? AS UNSIGNED) keeps the comparison integer-exact; comparing a BIGINT
    // column to a string parameter would go through DOUBLE.
    const [accruedRows] = await db.execute<EntityAmountRow[]>(
      `SELECT
         CAST(si.id AS CHAR) AS entity_id,
         SUM(sil.total_cost) AS amount
       FROM stock_ins si
       JOIN stock_in_lines sil ON sil.stock_in_id = si.id
       WHERE si.type = 'purchase' AND si.id > CAST(? AS UNSIGNED)
       GROUP BY si.id
       ORDER BY si.id ASC`,
      [stockInHighWaterId],
    );
    const [paidRows] = await db.execute<EntityAmountRow[]>(
      `SELECT
         CAST(si.id AS CHAR) AS entity_id,
         SUM(sip.amount) AS amount
       FROM stock_ins si
       JOIN stock_in_payments sip ON sip.stock_in_id = si.id
       WHERE si.type = 'purchase'
         AND si.id > CAST(? AS UNSIGNED)
         AND sip.id > CAST(? AS UNSIGNED)
       GROUP BY si.id
       ORDER BY si.id ASC`,
      [stockInHighWaterId, stockInPaymentHighWaterId],
    );
    const [legacyPaidRows] = await db.execute<RowDataPacket[]>(
      `SELECT SUM(sip.amount) AS amount
       FROM stock_ins si
       JOIN stock_in_payments sip ON sip.stock_in_id = si.id
       WHERE si.type = 'purchase'
         AND si.id <= CAST(? AS UNSIGNED)
         AND sip.id > CAST(? AS UNSIGNED)`,
      [stockInHighWaterId, stockInPaymentHighWaterId],
    );

    // Legacy entity first, so it always appears even when nothing is owed.
    const accrued = new Map([[LEGACY_STOCK_ENTITY_ID, cutover.openingUnpaidStock]]);
    for (const [id, amount] of toEntityMap(accruedRows)) accrued.set(id, amount);

    const paid = new Map<string, string>();
    const legacyPaid: unknown = legacyPaidRows[0]?.amount;
    if (legacyPaid !== null && legacyPaid !== undefined) {
      paid.set(LEGACY_STOCK_ENTITY_ID, String(legacyPaid));
    }
    for (const [id, amount] of toEntityMap(paidRows)) paid.set(id, amount);

    return { accrued, paid };
  }

  /**
   * Appends one ledger event using the supplied pool or (transaction) connection.
   * A retry for the same (source_type, source_id, event_type) is rejected by
   * uq_liquidity_events_source with ER_DUP_ENTRY; callers decide how to handle it.
   */
  async appendEvent(data: AppendLiquidityEventData, db: Db): Promise<number> {
    toPositiveIdBigInt(data.sourceId);

    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO liquidity_events (
         event_type,
         source_type,
         source_id,
         amount_delta,
         effective_date,
         created_by
       ) VALUES (?, ?, CAST(? AS UNSIGNED), ?, ?, ?)`,
      [
        data.eventType,
        data.sourceType,
        data.sourceId,
        data.amountDelta,
        data.effectiveDate,
        data.createdBy ?? null,
      ],
    );
    return result.insertId;
  }
}

export const liquidityRepository = new LiquidityRepository();
