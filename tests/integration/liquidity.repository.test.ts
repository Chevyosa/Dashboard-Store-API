import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sumUnpaidPerEntity } from '../../src/domain/liquidity.js';
import {
  isAfterCutoverDate,
  LEGACY_STOCK_ENTITY_ID,
  LiquidityRepository,
} from '../../src/repositories/liquidity.repository.js';
import type { LiquidityCutoverEntity } from '../../src/repositories/liquidity.repository.js';
import { cleanDatabase, createTestPool } from '../helpers/db.js';

const pool = createTestPool();
const repo = new LiquidityRepository();

// Larger than Number.MAX_SAFE_INTEGER, so a lossy number round-trip would show.
const HUGE_ID = '9007199254740993';

async function insertConsignor(name: string): Promise<string> {
  const [r] = await pool.execute<ResultSetHeader>('INSERT INTO consignors (name) VALUES (?)', [name]);
  return String(r.insertId);
}

async function insertOpname(date: string, status: 'draft' | 'final'): Promise<number> {
  const [r] = await pool.execute<ResultSetHeader>(
    'INSERT INTO opnames (opname_date, status) VALUES (?, ?)',
    [date, status],
  );
  return r.insertId;
}

async function insertAccrual(opnameId: number, consignorId: string, payoutDue: string): Promise<void> {
  await pool.execute(
    'INSERT INTO opname_consignor_payouts (opname_id, consignor_id, payout_due) VALUES (?, ?, ?)',
    [opnameId, consignorId, payoutDue],
  );
}

async function insertConsignorPayment(consignorId: string, amount: string): Promise<void> {
  await pool.execute(
    `INSERT INTO consignor_payments (consignor_id, amount, payment_date) VALUES (?, ?, '2026-03-05')`,
    [consignorId, amount],
  );
}

async function insertProduct(): Promise<number> {
  const [r] = await pool.execute<ResultSetHeader>(
    `INSERT INTO products (name, owner_type, sell_price) VALUES ('Kopi', 'own', '5000.0000')`,
  );
  return r.insertId;
}

async function insertStockIn(
  type: 'purchase' | 'consignment_in' | 'initial',
  productId: number,
  lineCosts: string[],
  explicitId?: string,
): Promise<string> {
  const [r] = await pool.execute<ResultSetHeader>(
    explicitId === undefined
      ? `INSERT INTO stock_ins (type, date) VALUES (?, '2026-03-04')`
      : `INSERT INTO stock_ins (id, type, date) VALUES (CAST(? AS UNSIGNED), ?, '2026-03-04')`,
    explicitId === undefined ? [type] : [explicitId, type],
  );
  // insertId is a lossy JS number above 2^53, so an explicit id is kept as given.
  const id = explicitId ?? String(r.insertId);
  for (const cost of lineCosts) {
    await pool.execute(
      `INSERT INTO stock_in_lines (stock_in_id, product_id, qty_pcs, total_cost)
       VALUES (CAST(? AS UNSIGNED), ?, 1, ?)`,
      [id, productId, cost],
    );
  }
  return id;
}

let uuidCounter = 0;
/** Returns the payment id as a string so it can serve as a cutover watermark. */
async function insertStockPayment(
  stockInId: string,
  amount: string,
  explicitId?: string,
): Promise<string> {
  uuidCounter += 1;
  const key = `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
  const [r] = await pool.execute<ResultSetHeader>(
    explicitId === undefined
      ? `INSERT INTO stock_in_payments (stock_in_id, amount, payment_date, idempotency_key)
         VALUES (CAST(? AS UNSIGNED), ?, '2026-03-06', ?)`
      : `INSERT INTO stock_in_payments (id, stock_in_id, amount, payment_date, idempotency_key)
         VALUES (CAST(? AS UNSIGNED), CAST(? AS UNSIGNED), ?, '2026-03-06', ?)`,
    explicitId === undefined ? [stockInId, amount, key] : [explicitId, stockInId, amount, key],
  );
  return explicitId ?? String(r.insertId);
}

/** In-memory cutover snapshot; the stock query reads only its stock fields. */
function cutover(fields: Partial<LiquidityCutoverEntity> = {}): LiquidityCutoverEntity {
  return {
    openingAmount: '0.0000',
    openingUnpaidStock: '0.0000',
    cutoverAt: '2026-03-05 00:00:00.000',
    opnameHighWaterId: '0',
    stockInHighWaterId: '0',
    stockInPaymentHighWaterId: '0',
    consignorPaymentHighWaterId: '0',
    takeProfitHighWaterId: '0',
    createdBy: null,
    createdAt: '2026-03-05 00:00:00',
    ...fields,
  };
}

describe('LiquidityRepository', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('findCutover', () => {
    it('returns null before the cutover is initialized', async () => {
      expect(await repo.findCutover(pool)).toBeNull();
    });

    it('returns the singleton row with BIGINT watermarks preserved as strings', async () => {
      await pool.execute(
        `INSERT INTO liquidity_cutover (
           id, opening_amount, opening_unpaid_stock, cutover_at, opname_high_water_id,
           stock_in_high_water_id, stock_in_payment_high_water_id,
           consignor_payment_high_water_id, take_profit_high_water_id
         ) VALUES (1, '1500000.2500', '320000.0001', '2026-03-01 08:30:00.123', ?, '42', ?, '7', '0')`,
        [HUGE_ID, HUGE_ID],
      );

      const found = await repo.findCutover(pool);
      expect(found).toEqual({
        openingAmount: '1500000.2500',
        openingUnpaidStock: '320000.0001',
        cutoverAt: '2026-03-01 08:30:00.123',
        opnameHighWaterId: HUGE_ID,
        stockInHighWaterId: '42',
        stockInPaymentHighWaterId: HUGE_ID,
        consignorPaymentHighWaterId: '7',
        takeProfitHighWaterId: '0',
        createdBy: null,
        createdAt: expect.any(String) as string,
      });
    });

    it('maps the column defaults when unpaid stock and payment watermark are omitted', async () => {
      await pool.execute(
        `INSERT INTO liquidity_cutover (
           opening_amount, cutover_at, opname_high_water_id, stock_in_high_water_id,
           consignor_payment_high_water_id, take_profit_high_water_id
         ) VALUES ('10.0000', '2026-03-01 08:30:00.000', 0, 0, 0, 0)`,
      );

      const found = await repo.findCutover(pool);
      expect(found?.openingAmount).toBe('10.0000');
      expect(found?.openingUnpaidStock).toBe('0.0000');
      expect(found?.stockInPaymentHighWaterId).toBe('0');
    });
  });

  describe('lockCutoverForUpdate', () => {
    async function insertCutover(db: PoolConnection | typeof pool = pool): Promise<void> {
      await db.execute(
        `INSERT INTO liquidity_cutover (
           id, opening_amount, cutover_at, opname_high_water_id, stock_in_high_water_id,
           consignor_payment_high_water_id, take_profit_high_water_id
         ) VALUES (1, '250000.0000', '2026-03-05 18:45:00.000', 3, 4, 5, 6)`,
      );
    }

    async function lockWaitTimeoutConn(): Promise<PoolConnection> {
      const conn = await pool.getConnection();
      await conn.query('SET SESSION innodb_lock_wait_timeout = 1');
      return conn;
    }

    it('returns null inside a transaction before the cutover is initialized', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        expect(await repo.lockCutoverForUpdate(conn)).toBeNull();
      } finally {
        await conn.rollback();
        conn.release();
      }
    });

    it('returns the cutover snapshot once initialized', async () => {
      await insertCutover();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const locked = await repo.lockCutoverForUpdate(conn);
        expect(locked).toMatchObject({
          openingAmount: '250000.0000',
          cutoverAt: '2026-03-05 18:45:00.000',
          opnameHighWaterId: '3',
          stockInHighWaterId: '4',
          consignorPaymentHighWaterId: '5',
          takeProfitHighWaterId: '6',
        });
      } finally {
        await conn.rollback();
        conn.release();
      }
    });

    it('blocks a concurrent one-time cutover insert while a source write holds the gap lock', async () => {
      const holder = await pool.getConnection();
      const inserter = await lockWaitTimeoutConn();
      try {
        await holder.beginTransaction();
        expect(await repo.lockCutoverForUpdate(holder)).toBeNull();

        await inserter.beginTransaction();
        await expect(insertCutover(inserter)).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });
        await inserter.rollback();

        // Once the source write ends, the cutover can be inserted.
        await holder.commit();
        await inserter.beginTransaction();
        await insertCutover(inserter);
        await inserter.commit();
        expect(await repo.findCutover(pool)).not.toBeNull();
      } finally {
        await holder.rollback().catch(() => undefined);
        await inserter.rollback().catch(() => undefined);
        holder.release();
        inserter.release();
      }
    });

    it('serializes source writes with each other after cutover (exclusive, not shared)', async () => {
      await insertCutover();
      const first = await pool.getConnection();
      const second = await lockWaitTimeoutConn();
      try {
        await first.beginTransaction();
        expect(await repo.lockCutoverForUpdate(first)).not.toBeNull();

        await second.beginTransaction();
        await expect(repo.lockCutoverForUpdate(second)).rejects.toMatchObject({
          code: 'ER_LOCK_WAIT_TIMEOUT',
        });
        await second.rollback();

        await first.commit();
        await second.beginTransaction();
        expect(await repo.lockCutoverForUpdate(second)).not.toBeNull();
        await second.commit();
      } finally {
        await first.rollback().catch(() => undefined);
        await second.rollback().catch(() => undefined);
        first.release();
        second.release();
      }
    });
  });

  describe('isAfterCutoverDate', () => {
    it('accepts only dates strictly later than the calendar date of cutoverAt', () => {
      const c = cutover({ cutoverAt: '2026-03-05 23:59:59.999' });
      expect(isAfterCutoverDate(c, '2026-03-04')).toBe(false);
      expect(isAfterCutoverDate(c, '2026-03-05')).toBe(false);
      expect(isAfterCutoverDate(c, '2026-03-06')).toBe(true);
      expect(isAfterCutoverDate(cutover({ cutoverAt: '2026-03-05 00:00:00.000' }), '2026-03-05')).toBe(
        false,
      );
    });
  });

  describe('sumEventBalance', () => {
    it('returns zero for an empty ledger', async () => {
      expect(await repo.sumEventBalance(pool)).toBe('0.0000');
    });

    it('sums signed amount_delta exactly as a decimal string', async () => {
      await repo.appendEvent(
        { eventType: 'opening', sourceType: 'cutover', sourceId: '1', amountDelta: '1000000.1000', effectiveDate: '2026-03-01' },
        pool,
      );
      await repo.appendEvent(
        { eventType: 'opname_inflow', sourceType: 'opname', sourceId: '5', amountDelta: '0.2000', effectiveDate: '2026-03-02' },
        pool,
      );
      await repo.appendEvent(
        { eventType: 'stock_payment', sourceType: 'stock_in_payment', sourceId: '9', amountDelta: '-250000.3333', effectiveDate: '2026-03-03' },
        pool,
      );
      await repo.appendEvent(
        { eventType: 'reversal', sourceType: 'stock_in_payment', sourceId: '9', amountDelta: '0.0001', effectiveDate: '2026-03-03' },
        pool,
      );

      // 1000000.1000 + 0.2000 - 250000.3333 + 0.0001 (float math would drift)
      expect(await repo.sumEventBalance(pool)).toBe('749999.9668');
    });
  });

  describe('getConsignorObligationTotals', () => {
    it('groups finalized accruals and payments per consignor as string ids/amounts', async () => {
      const a = await insertConsignor('Bu Ani');
      const b = await insertConsignor('Pak Budi');
      const c = await insertConsignor('Cici');
      const final1 = await insertOpname('2026-03-01', 'final');
      const final2 = await insertOpname('2026-03-08', 'final');
      const draft = await insertOpname('2026-03-15', 'draft');

      await insertAccrual(final1, a, '100000.0000');
      await insertAccrual(final2, a, '50000.5000');
      await insertAccrual(final1, b, '30000.0000');
      await insertAccrual(draft, a, '999999.0000'); // draft: not yet owed
      await insertAccrual(draft, c, '777.0000'); // draft-only consignor

      await insertConsignorPayment(a, '120000.0000');
      await insertConsignorPayment(b, '20000.0000');
      await insertConsignorPayment(b, '25000.0000'); // overpaid by 15000

      const totals = await repo.getConsignorObligationTotals(pool);

      expect(totals.accrued).toEqual(
        new Map([
          [a, '150000.5000'],
          [b, '30000.0000'],
        ]),
      );
      expect(totals.paid).toEqual(
        new Map([
          [a, '120000.0000'],
          [b, '45000.0000'],
        ]),
      );
      // B's overpayment must not cancel A's debt.
      expect(sumUnpaidPerEntity(totals).toFixed(4)).toBe('30000.5000');
    });

    it('returns empty maps when nothing is recorded', async () => {
      const totals = await repo.getConsignorObligationTotals(pool);
      expect(totals.accrued.size).toBe(0);
      expect(totals.paid.size).toBe(0);
    });
  });

  describe('getPurchaseStockObligationTotals', () => {
    it('includes opening unpaid stock as a synthetic legacy entity', async () => {
      const productId = await insertProduct();
      const old = await insertStockIn('purchase', productId, ['70000.0000']);

      const totals = await repo.getPurchaseStockObligationTotals(
        cutover({ openingUnpaidStock: '300000.5000', stockInHighWaterId: old }),
        pool,
      );

      expect(totals.accrued).toEqual(new Map([[LEGACY_STOCK_ENTITY_ID, '300000.5000']]));
      expect(totals.paid.size).toBe(0);
      // Old receipts count only through the legacy amount, never by their own line cost.
      expect(totals.accrued.has(old)).toBe(false);
      expect(sumUnpaidPerEntity(totals).toFixed(4)).toBe('300000.5000');
    });

    it('reduces the legacy debt by post-cutover payments against old receipts', async () => {
      const productId = await insertProduct();
      const old1 = await insertStockIn('purchase', productId, ['70000.0000']);
      const old2 = await insertStockIn('purchase', productId, ['60000.0000']);
      const prePayment = await insertStockPayment(old1, '5000.0000');
      await insertStockPayment(old1, '20000.0000');
      await insertStockPayment(old2, '10000.2500');

      const totals = await repo.getPurchaseStockObligationTotals(
        cutover({
          openingUnpaidStock: '100000.0000',
          stockInHighWaterId: old2,
          stockInPaymentHighWaterId: prePayment,
        }),
        pool,
      );

      expect(totals.accrued).toEqual(new Map([[LEGACY_STOCK_ENTITY_ID, '100000.0000']]));
      expect(totals.paid).toEqual(new Map([[LEGACY_STOCK_ENTITY_ID, '30000.2500']]));
      expect(sumUnpaidPerEntity(totals).toFixed(4)).toBe('69999.7500');
    });

    it('does not subtract payments at or below the payment watermark again', async () => {
      const productId = await insertProduct();
      const old = await insertStockIn('purchase', productId, ['70000.0000']);
      await insertStockPayment(old, '40000.0000');
      const lastPrePayment = await insertStockPayment(old, '15000.0000');

      const totals = await repo.getPurchaseStockObligationTotals(
        cutover({
          openingUnpaidStock: '15000.0000',
          stockInHighWaterId: old,
          stockInPaymentHighWaterId: lastPrePayment,
        }),
        pool,
      );

      expect(totals.accrued).toEqual(new Map([[LEGACY_STOCK_ENTITY_ID, '15000.0000']]));
      expect(totals.paid.size).toBe(0);
      expect(sumUnpaidPerEntity(totals).toFixed(4)).toBe('15000.0000');
    });

    it('keeps new receipts as partial-payment obligations per stock-in', async () => {
      const productId = await insertProduct();
      const old = await insertStockIn('purchase', productId, ['999.0000']);
      const s1 = await insertStockIn('purchase', productId, ['100000.0000', '25000.5000']);
      const s2 = await insertStockIn('purchase', productId, ['40000.0000']);
      const s3 = await insertStockIn('purchase', productId, ['8000.0000']);

      await insertStockPayment(s1, '50000.0000');
      await insertStockPayment(s1, '25000.0000');
      await insertStockPayment(s2, '40000.0000');

      const totals = await repo.getPurchaseStockObligationTotals(
        cutover({ stockInHighWaterId: old }),
        pool,
      );

      expect(totals.accrued).toEqual(
        new Map([
          [LEGACY_STOCK_ENTITY_ID, '0.0000'],
          [s1, '125000.5000'],
          [s2, '40000.0000'],
          [s3, '8000.0000'],
        ]),
      );
      expect(totals.paid).toEqual(
        new Map([
          [s1, '75000.0000'],
          [s2, '40000.0000'],
        ]),
      );
      expect(sumUnpaidPerEntity(totals).toFixed(4)).toBe('58000.5000');
    });

    it('floors each entity so a legacy overpayment cannot hide new receipt debt', async () => {
      const productId = await insertProduct();
      const old = await insertStockIn('purchase', productId, ['70000.0000']);
      const fresh = await insertStockIn('purchase', productId, ['10000.0000']);
      await insertStockPayment(old, '9000.0000'); // exceeds the 5000 legacy debt
      await insertStockPayment(fresh, '4000.0000');

      const totals = await repo.getPurchaseStockObligationTotals(
        cutover({ openingUnpaidStock: '5000.0000', stockInHighWaterId: old }),
        pool,
      );

      expect(totals.paid).toEqual(
        new Map([
          [LEGACY_STOCK_ENTITY_ID, '9000.0000'],
          [fresh, '4000.0000'],
        ]),
      );
      expect(sumUnpaidPerEntity(totals).toFixed(4)).toBe('6000.0000');
    });

    it('excludes consignment and initial stock-ins on both sides of the cutover', async () => {
      const productId = await insertProduct();
      const oldConsign = await insertStockIn('consignment_in', productId, ['9999.0000']);
      const consign = await insertStockIn('consignment_in', productId, ['9999.0000']);
      const initial = await insertStockIn('initial', productId, ['8888.0000']);
      await insertStockPayment(oldConsign, '1111.0000');
      await insertStockPayment(consign, '2222.0000');
      await insertStockPayment(initial, '3333.0000');

      const totals = await repo.getPurchaseStockObligationTotals(
        cutover({ openingUnpaidStock: '50000.0000', stockInHighWaterId: oldConsign }),
        pool,
      );

      expect(totals.accrued).toEqual(new Map([[LEGACY_STOCK_ENTITY_ID, '50000.0000']]));
      expect(totals.paid.size).toBe(0);
      expect(sumUnpaidPerEntity(totals).toFixed(4)).toBe('50000.0000');
    });

    it('preserves exact BIGINT ids beyond 2^53 in keys and watermark comparisons', async () => {
      const productId = await insertProduct();
      // 2^53 and 2^53 + 1 collapse to the same DOUBLE, so a float comparison would fail here.
      const TWO_POW_53 = '9007199254740992';
      const old = await insertStockIn('purchase', productId, ['1.0000'], TWO_POW_53);
      const fresh = await insertStockIn('purchase', productId, ['500.0000'], HUGE_ID);
      await insertStockPayment(old, '7.0000', TWO_POW_53);
      await insertStockPayment(old, '3.0000', HUGE_ID);
      await insertStockPayment(fresh, '200.0000');

      const totals = await repo.getPurchaseStockObligationTotals(
        cutover({
          openingUnpaidStock: '100.0000',
          stockInHighWaterId: TWO_POW_53,
          stockInPaymentHighWaterId: TWO_POW_53,
        }),
        pool,
      );

      expect([...totals.accrued.keys()]).toEqual([LEGACY_STOCK_ENTITY_ID, HUGE_ID]);
      expect(totals.accrued.get(HUGE_ID)).toBe('500.0000');
      expect(totals.paid).toEqual(
        new Map([
          [LEGACY_STOCK_ENTITY_ID, '3.0000'],
          [HUGE_ID, '200.0000'],
        ]),
      );
      expect(sumUnpaidPerEntity(totals).toFixed(4)).toBe('397.0000');
    });

    it('rejects malformed watermarks', async () => {
      for (const bad of ['1 OR 1=1', '-1', '1.5', '']) {
        await expect(
          repo.getPurchaseStockObligationTotals(cutover({ stockInHighWaterId: bad }), pool),
          `stockInHighWaterId ${bad}`,
        ).rejects.toThrow();
        await expect(
          repo.getPurchaseStockObligationTotals(cutover({ stockInPaymentHighWaterId: bad }), pool),
          `stockInPaymentHighWaterId ${bad}`,
        ).rejects.toThrow();
      }
    });
  });

  describe('appendEvent', () => {
    it('inserts one typed event and returns its insert id', async () => {
      const id = await repo.appendEvent(
        {
          eventType: 'owner_withdrawal',
          sourceType: 'take_profit',
          sourceId: HUGE_ID,
          amountDelta: '-12345.6789',
          effectiveDate: '2026-03-10',
          createdBy: null,
        },
        pool,
      );

      expect(id).toBeGreaterThan(0);
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT event_type, source_type, CAST(source_id AS CHAR) AS source_id, amount_delta,
                DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, created_by
         FROM liquidity_events WHERE id = ?`,
        [id],
      );
      expect(rows).toEqual([
        {
          event_type: 'owner_withdrawal',
          source_type: 'take_profit',
          source_id: HUGE_ID,
          amount_delta: '-12345.6789',
          effective_date: '2026-03-10',
          created_by: null,
        },
      ]);
    });

    it('writes through a supplied transaction connection', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await repo.appendEvent(
          { eventType: 'opname_inflow', sourceType: 'opname', sourceId: '3', amountDelta: '500.0000', effectiveDate: '2026-03-02' },
          conn,
        );
        expect(await repo.sumEventBalance(conn)).toBe('500.0000');
        await conn.rollback();
      } finally {
        conn.release();
      }
      expect(await repo.sumEventBalance(pool)).toBe('0.0000');
    });

    it('rejects a retried event for the same source and type', async () => {
      const event = {
        eventType: 'consignor_payment',
        sourceType: 'consignor_payment',
        sourceId: '11',
        amountDelta: '-1000.0000',
        effectiveDate: '2026-03-05',
      } as const;
      await repo.appendEvent(event, pool);

      await expect(repo.appendEvent(event, pool)).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      expect(await repo.sumEventBalance(pool)).toBe('-1000.0000');
    });

    it('rejects a malformed source id', async () => {
      await expect(
        repo.appendEvent(
          { eventType: 'opname_inflow', sourceType: 'opname', sourceId: '1.5', amountDelta: '1.0000', effectiveDate: '2026-03-02' },
          pool,
        ),
      ).rejects.toThrow();
    });
  });
});
