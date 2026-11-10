import type { Express } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { LiquidityRepository } from '../../src/repositories/liquidity.repository.js';
import { createAdmin } from '../../src/services/admin.service.js';
import { cleanDatabase, createTestPool, getTestEnv } from '../helpers/db.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const pool = createTestPool();
const env = getTestEnv();
let app: Express;
let sessionCookie: string;

function tokenFrom(res: request.Response): string {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] ?? '';
  return raw.split(';')[0]?.split('=')[1] ?? '';
}

async function loginAdmin(): Promise<string> {
  await createAdmin(pool, { username: 'owner', password: 'password-rahasia-123' }, () => T0);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ username: 'owner', password: 'password-rahasia-123' });
  return tokenFrom(res);
}

const authedGet = (url: string) =>
  request(app)
    .get(url)
    .set('Cookie', `store_sid=${sessionCookie}`);

const authedPost = (url: string, body?: unknown) =>
  request(app)
    .post(url)
    .set('Cookie', `store_sid=${sessionCookie}`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .send(body as object);

const authedPut = (url: string, body?: unknown) =>
  request(app)
    .put(url)
    .set('Cookie', `store_sid=${sessionCookie}`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .send(body as object);

const authedDelete = (url: string) =>
  request(app)
    .delete(url)
    .set('Cookie', `store_sid=${sessionCookie}`)
    .set('X-Requested-With', 'XMLHttpRequest');

describe('Take Profit API (/api/v1/take-profits)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Security & Authentication Guards', () => {
    it('returns 401 UNAUTHENTICATED when accessing without session', async () => {
      const res = await request(app).get('/api/v1/take-profits/overview');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 403 CSRF_REJECTED on POST without header', async () => {
      const res = await request(app)
        .post('/api/v1/take-profits')
        .set('Cookie', `store_sid=${sessionCookie}`)
        .send({
          amount: '100000',
          withdrawalDate: '2026-03-02',
          paymentMethod: 'cash',
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    });

    it('returns 403 CSRF_REJECTED on PUT without header', async () => {
      const res = await request(app)
        .put('/api/v1/take-profits/settings/working-capital')
        .set('Cookie', `store_sid=${sessionCookie}`)
        .send({ minWorkingCapital: '500000' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    });

    it('returns 403 CSRF_REJECTED on DELETE without header', async () => {
      const res = await request(app)
        .delete('/api/v1/take-profits/1')
        .set('Cookie', `store_sid=${sessionCookie}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    });
  });

  describe('Overview Calculation (Formula & Edge Cases)', () => {
    it('returns safe=false with warning when no final opname exists', async () => {
      const res = await authedGet('/api/v1/take-profits/overview');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        latestOpname: null,
        totalUnpaidConsignorBalance: '0.0000',
        minWorkingCapital: '400000.0000',
        withdrawnCurrentPeriod: '0.0000',
        totalWithdrawnAllTime: '0.0000',
        availableToWithdraw: '0.0000',
        isSafe: false,
        liquidityInitialized: false,
        currentLiquidBalance: null,
        unpaidStockPurchaseBalance: '0.0000',
        totalUnpaidObligations: '0.0000',
      });
      expect(res.body.data.warningReason).toContain('Belum ada opname final');
    });

    it('calculates available take-profit correctly when opname and debts exist', async () => {
      // 1. Create a consignor
      const consignorRes = await authedPost('/api/v1/consignors', {
        name: 'Ibu Ani',
        phone: '08111111111',
      });
      const consignorId = consignorRes.body.data.id;

      // 2. Insert final opname with real_cash = 1.000.000 (e.g. 600k cash + 400k qris)
      const [opnameRes] = await pool.execute<ResultSetHeader>(
        `INSERT INTO opnames (
           opname_date, status, total_turnover, total_sold_qty, total_loss_qty,
           total_cogs, total_payout_due, cash_amount, qris_amount, real_cash
         ) VALUES (
           '2026-03-01', 'final', 1000000, 100, 0, 0, 300000, 600000, 400000, 1000000
         )`,
      );
      const opnameId = opnameRes.insertId;

      // 3. Insert consignor payout due = 300.000
      await pool.execute(
        `INSERT INTO opname_consignor_payouts (opname_id, consignor_id, sold_share, loss_compensation, payout_due)
         VALUES (?, ?, 300000, 0, 300000)`,
        [opnameId, consignorId],
      );

      // Formula:
      // Real Cash (1.000.000) - Payout (300.000) - Min Working Capital (400.000) - Withdrawn (0)
      // = 300.000 halal ditarik
      const res = await authedGet('/api/v1/take-profits/overview');
      expect(res.status).toBe(200);
      expect(res.body.data.latestOpname).toMatchObject({
        id: opnameId,
        opnameDate: '2026-03-01',
        realCash: '1000000.0000',
        totalPayoutDue: '300000.0000',
      });
      expect(res.body.data.totalPayout).toBe('300000.0000');
      expect(res.body.data.payoutPaid).toBe('0.0000');
      expect(res.body.data.payoutUnpaid).toBe('300000.0000');
      expect(res.body.data.payoutStatus).toBe('unpaid');
      expect(res.body.data.minWorkingCapital).toBe('400000.0000');
      expect(res.body.data.withdrawnCurrentPeriod).toBe('0.0000');
      expect(res.body.data.availableToWithdraw).toBe('300000.0000');
      expect(res.body.data.rawBalance).toBe('300000.0000');
      expect(res.body.data.isSafe).toBe(true);
      expect(res.body.data.warningReason).toBeNull();
      expect(res.body.data.liquidityInitialized).toBe(false);
      expect(res.body.data.currentLiquidBalance).toBeNull();
      expect(res.body.data.unpaidStockPurchaseBalance).toBe('0.0000');
      expect(res.body.data.totalUnpaidObligations).toBe('300000.0000');
      expect(res.body.data.liquidityShortfall).toBe('0.0000');

      // Now simulate owner paying the consignor Rp 300.000 (User's real scenario)
      await authedPost('/api/v1/payouts/payments', {
        consignorId,
        amount: '300000',
        paymentDate: '2026-03-02',
        paymentMethod: 'cash',
      });

      // After payout is paid, totalPayout remains 300.000, payoutStatus transitions to 'settled',
      // and availableToWithdraw remains consistently 300.000!
      const resAfterPay = await authedGet('/api/v1/take-profits/overview');
      expect(resAfterPay.status).toBe(200);
      expect(resAfterPay.body.data.totalPayout).toBe('300000.0000');
      expect(resAfterPay.body.data.payoutPaid).toBe('300000.0000');
      expect(resAfterPay.body.data.payoutUnpaid).toBe('0.0000');
      expect(resAfterPay.body.data.payoutStatus).toBe('settled');
      expect(resAfterPay.body.data.availableToWithdraw).toBe('300000.0000');
      expect(resAfterPay.body.data.rawBalance).toBe('300000.0000');
      expect(resAfterPay.body.data.isSafe).toBe(true);
    });

    it('returns warning when cash is insufficient to cover liabilities and working capital', async () => {
      // Create consignor
      const consignorRes = await authedPost('/api/v1/consignors', {
        name: 'Ibu Budi',
        phone: '08222222222',
      });
      const consignorId = consignorRes.body.data.id;

      // Final opname with real_cash = 500.000, but unpaid consignors = 400.000, working capital = 400.000
      // 500k - 400k - 400k = -300k
      const [opnameRes] = await pool.execute<ResultSetHeader>(
        `INSERT INTO opnames (
           opname_date, status, total_turnover, total_sold_qty, total_loss_qty,
           total_cogs, total_payout_due, cash_amount, qris_amount, real_cash
         ) VALUES (
           '2026-03-01', 'final', 500000, 50, 0, 0, 400000, 500000, 0, 500000
         )`,
      );
      const opnameId = opnameRes.insertId;

      await pool.execute(
        `INSERT INTO opname_consignor_payouts (opname_id, consignor_id, sold_share, loss_compensation, payout_due)
         VALUES (?, ?, 400000, 0, 400000)`,
        [opnameId, consignorId],
      );

      const res = await authedGet('/api/v1/take-profits/overview');
      expect(res.status).toBe(200);
      expect(res.body.data.availableToWithdraw).toBe('0.0000');
      expect(res.body.data.rawBalance).toBe('-300000.0000');
      expect(res.body.data.isSafe).toBe(false);
      expect(res.body.data.warningReason).toContain('belum aman untuk ditarik');
      expect(res.body.data.liquidityInitialized).toBe(false);
      expect(res.body.data.currentLiquidBalance).toBeNull();
      expect(res.body.data.liquidityShortfall).toBe('300000.0000');

      // Before cutover a withdrawal is recorded without the ledger guard (unchanged behavior).
      const tp = await authedPost('/api/v1/take-profits', {
        amount: '100000',
        withdrawalDate: '2026-03-02',
        paymentMethod: 'cash',
      });
      expect(tp.status).toBe(201);
    });
  });

  describe('Settings: Update Working Capital Buffer', () => {
    it('updates working capital setting and recalculates overview', async () => {
      // 1. Update working capital to 600,000
      const putRes = await authedPut('/api/v1/take-profits/settings/working-capital', {
        minWorkingCapital: '600000',
      });
      expect(putRes.status).toBe(200);
      expect(putRes.body.data.minWorkingCapital).toBe('600000.0000');

      // Check overview
      const overviewRes = await authedGet('/api/v1/take-profits/overview');
      expect(overviewRes.body.data.minWorkingCapital).toBe('600000.0000');

      // Check audit log
      const [logs] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM audit_log WHERE action = 'store_settings.working_capital_updated'",
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]?.entity_id).toBe('min_working_capital');
    });

    it('rejects invalid minWorkingCapital values', async () => {
      const resNegative = await authedPut('/api/v1/take-profits/settings/working-capital', {
        minWorkingCapital: '-100',
      });
      expect(resNegative.status).toBe(400);

      const resNonNumeric = await authedPut('/api/v1/take-profits/settings/working-capital', {
        minWorkingCapital: 'abc',
      });
      expect(resNonNumeric.status).toBe(400);
    });
  });

  describe('Take Profit Withdrawals CRUD', () => {
    it('records a withdrawal, adjusts overview withdrawn amounts, and lists records', async () => {
      // 1. Insert final opname with 1.000.000 real cash
      const [opnameRes] = await pool.execute<ResultSetHeader>(
        `INSERT INTO opnames (
           opname_date, status, total_turnover, total_sold_qty, total_loss_qty,
           total_cogs, total_payout_due, cash_amount, qris_amount, real_cash
         ) VALUES (
           '2026-03-01', 'final', 1000000, 100, 0, 0, 0, 1000000, 0, 1000000
         )`,
      );
      const opnameId = opnameRes.insertId;

      // Available: 1.000.000 - 0 (unpaid) - 400.000 (capital) = 600.000
      // 2. Withdraw 250.000
      const postRes = await authedPost('/api/v1/take-profits', {
        opnameId,
        amount: '250000',
        withdrawalDate: '2026-03-02',
        paymentMethod: 'cash',
        note: 'Tarik laba minggu ke-1',
      });
      expect(postRes.status).toBe(201);
      const withdrawalId = postRes.body.data.id;
      expect(postRes.body.data.amount).toBe('250000.0000');
      expect(postRes.body.data.paymentMethod).toBe('cash');
      expect(postRes.body.data.note).toBe('Tarik laba minggu ke-1');

      // 3. Check overview updated
      const overviewRes = await authedGet('/api/v1/take-profits/overview');
      expect(overviewRes.body.data.withdrawnCurrentPeriod).toBe('250000.0000');
      expect(overviewRes.body.data.totalWithdrawnAllTime).toBe('250000.0000');
      // 600k - 250k = 350k remaining available
      expect(overviewRes.body.data.availableToWithdraw).toBe('350000.0000');

      // 4. List withdrawals
      const listRes = await authedGet('/api/v1/take-profits');
      expect(listRes.status).toBe(200);
      expect(listRes.body.data).toHaveLength(1);
      expect(listRes.body.data[0].id).toBe(withdrawalId);
      expect(listRes.body.pagination.total).toBe(1);

      // 5. Delete withdrawal
      const delRes = await authedDelete(`/api/v1/take-profits/${withdrawalId}`);
      expect(delRes.status).toBe(200);

      // Verify deleted from list
      const afterDelList = await authedGet('/api/v1/take-profits');
      expect(afterDelList.body.data).toHaveLength(0);

      // Overview restores available amount
      const overviewRestored = await authedGet('/api/v1/take-profits/overview');
      expect(overviewRestored.body.data.withdrawnCurrentPeriod).toBe('0.0000');
      expect(overviewRestored.body.data.availableToWithdraw).toBe('600000.0000');

      // Check audit logs for create and delete
      const [createLogs] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM audit_log WHERE action = 'take_profit.created'",
      );
      expect(createLogs).toHaveLength(1);

      const [delLogs] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM audit_log WHERE action = 'take_profit.deleted'",
      );
      expect(delLogs).toHaveLength(1);
    });

    it('rejects invalid inputs on create', async () => {
      // Zero amount
      const resZero = await authedPost('/api/v1/take-profits', {
        amount: '0',
        withdrawalDate: '2026-03-02',
        paymentMethod: 'cash',
      });
      expect(resZero.status).toBe(400);

      // Invalid payment method
      const resMethod = await authedPost('/api/v1/take-profits', {
        amount: '100000',
        withdrawalDate: '2026-03-02',
        paymentMethod: 'bitcoin',
      });
      expect(resMethod.status).toBe(400);

      // Invalid date
      const resDate = await authedPost('/api/v1/take-profits', {
        amount: '100000',
        withdrawalDate: 'invalid-date',
        paymentMethod: 'cash',
      });
      expect(resDate.status).toBe(400);
    });

    it('returns 404 when deleting non-existent record', async () => {
      const res = await authedDelete('/api/v1/take-profits/99999');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TAKE_PROFIT_NOT_FOUND');
    });
  });

  describe('After liquidity cutover (ledger-backed position)', () => {
    const CUTOVER_AT = '2026-03-01 15:00:00.000';
    const AFTER_CUTOFF = '2026-03-02';

    async function activateCutover(opts: {
      opening: string;
      openingUnpaidStock?: string;
      opnameHighWaterId?: number;
    }): Promise<void> {
      await pool.execute(
        `INSERT INTO liquidity_cutover
           (id, opening_amount, opening_unpaid_stock, cutover_at, opname_high_water_id,
            stock_in_high_water_id, consignor_payment_high_water_id, take_profit_high_water_id)
         VALUES (1, ?, ?, ?, ?, 0, 0, 0)`,
        [opts.opening, opts.openingUnpaidStock ?? '0', CUTOVER_AT, opts.opnameHighWaterId ?? 0],
      );
      await pool.execute(
        `INSERT INTO liquidity_events (event_type, source_type, source_id, amount_delta, effective_date)
         VALUES ('opening', 'cutover', 1, ?, '2026-03-01')`,
        [opts.opening],
      );
    }

    const withdraw = (amount: string) =>
      authedPost('/api/v1/take-profits', { amount, withdrawalDate: AFTER_CUTOFF, paymentMethod: 'cash' });

    async function countRows(table: string): Promise<number> {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${pool.escapeId(table)}`);
      return Number(rows[0]?.n ?? 0);
    }

    it('reports zero safe surplus and the shortfall when the ledger is below the reserve', async () => {
      await activateCutover({ opening: '296000' });
      const put = await authedPut('/api/v1/take-profits/settings/working-capital', {
        minWorkingCapital: '300000',
      });
      expect(put.status).toBe(200);

      const res = await authedGet('/api/v1/take-profits/overview');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        latestOpname: null,
        liquidityInitialized: true,
        currentLiquidBalance: '296000.0000',
        minWorkingCapital: '300000.0000',
        totalUnpaidConsignorBalance: '0.0000',
        unpaidStockPurchaseBalance: '0.0000',
        totalUnpaidObligations: '0.0000',
        totalPayout: '0.0000',
        payoutPaid: '0.0000',
        payoutUnpaid: '0.0000',
        payoutStatus: 'settled',
        availableToWithdraw: '0.0000',
        rawBalance: '-4000.0000',
        liquidityShortfall: '4000.0000',
        isSafe: false,
      });
      expect(res.body.data.warningReason).toContain('belum aman untuk ditarik');

      const tp = await withdraw('1');
      expect(tp.status).toBe(409);
      expect(tp.body.error.code).toBe('INSUFFICIENT_LIQUIDITY');
      expect(await countRows('take_profits')).toBe(0);
    });

    it('deducts unpaid legacy stock and per-consignor payouts, allows the exact surplus and rejects any excess', async () => {
      const consignorA = (await authedPost('/api/v1/consignors', { name: 'Ibu Ani', phone: '0811' })).body.data.id;
      const consignorB = (await authedPost('/api/v1/consignors', { name: 'Pak Budi', phone: '0812' })).body.data.id;

      // Pre-cutover history: B is overpaid by 50.000, A is owed 200.000 by a final opname.
      const prePay = await authedPost('/api/v1/payouts/payments', {
        consignorId: consignorB,
        amount: '50000',
        paymentDate: '2026-03-01',
        paymentMethod: 'cash',
      });
      expect(prePay.status).toBe(201);
      const [opnameRes] = await pool.execute<ResultSetHeader>(
        `INSERT INTO opnames (
           opname_date, status, total_turnover, total_sold_qty, total_loss_qty,
           total_cogs, total_payout_due, cash_amount, qris_amount, real_cash
         ) VALUES ('2026-03-01', 'final', 900000, 90, 0, 0, 200000, 900000, 0, 900000)`,
      );
      const opnameId = opnameRes.insertId;
      await pool.execute(
        `INSERT INTO opname_consignor_payouts (opname_id, consignor_id, sold_share, loss_compensation, payout_due)
         VALUES (?, ?, 200000, 0, 200000)`,
        [opnameId, consignorA],
      );

      await activateCutover({ opening: '1000000', openingUnpaidStock: '150000', opnameHighWaterId: opnameId });

      // Post-cutover partial payout to A: ledger 1.000.000 - 80.000 = 920.000; A still owed 120.000.
      const pay = await authedPost('/api/v1/payouts/payments', {
        consignorId: consignorA,
        amount: '80000',
        paymentDate: AFTER_CUTOFF,
        paymentMethod: 'cash',
      });
      expect(pay.status).toBe(201);

      // Required = reserve 400.000 + consignor 120.000 (B's overpayment must not offset A)
      //          + legacy unpaid stock 150.000 = 670.000; safe = 920.000 - 670.000 = 250.000.
      const res = await authedGet('/api/v1/take-profits/overview');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        liquidityInitialized: true,
        currentLiquidBalance: '920000.0000',
        minWorkingCapital: '400000.0000',
        totalUnpaidConsignorBalance: '120000.0000',
        unpaidStockPurchaseBalance: '150000.0000',
        totalUnpaidObligations: '270000.0000',
        totalPayout: '200000.0000',
        payoutPaid: '80000.0000',
        payoutUnpaid: '120000.0000',
        payoutStatus: 'partial',
        availableToWithdraw: '250000.0000',
        rawBalance: '250000.0000',
        liquidityShortfall: '0.0000',
        isSafe: true,
        warningReason: null,
      });

      const excess = await withdraw('250000.0001');
      expect(excess.status).toBe(409);
      expect(excess.body.error.code).toBe('INSUFFICIENT_LIQUIDITY');
      expect(await countRows('take_profits')).toBe(0);

      const exact = await withdraw('250000');
      expect(exact.status).toBe(201);
      expect(exact.body.data.opnameId).toBe(opnameId);

      const after = await authedGet('/api/v1/take-profits/overview');
      expect(after.body.data).toMatchObject({
        currentLiquidBalance: '670000.0000',
        availableToWithdraw: '0.0000',
        rawBalance: '0.0000',
        liquidityShortfall: '0.0000',
        withdrawnCurrentPeriod: '250000.0000',
        totalWithdrawnAllTime: '250000.0000',
      });

      const more = await withdraw('0.0001');
      expect(more.status).toBe(409);
      expect(more.body.error.code).toBe('INSUFFICIENT_LIQUIDITY');
      expect(await countRows('take_profits')).toBe(1);
      const [events] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM liquidity_events WHERE event_type = 'owner_withdrawal'",
      );
      expect(Number(events[0]?.n)).toBe(1);
    });

    it('applies a reserve change to the guard', async () => {
      await activateCutover({ opening: '500000' });
      const put = await authedPut('/api/v1/take-profits/settings/working-capital', {
        minWorkingCapital: '450000',
      });
      expect(put.status).toBe(200);

      expect((await withdraw('50000.0001')).status).toBe(409);
      expect((await withdraw('50000')).status).toBe(201);
    });

    it('never lets concurrent withdrawals exceed the safe surplus', async () => {
      // Safe = 500.000 - 400.000 default reserve = 100.000; only two 40.000 withdrawals fit.
      await activateCutover({ opening: '500000' });

      const results = await Promise.all([withdraw('40000'), withdraw('40000'), withdraw('40000')]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
      expect(results.find((r) => r.status === 409)?.body.error.code).toBe('INSUFFICIENT_LIQUIDITY');
      expect(await countRows('take_profits')).toBe(2);

      const overview = await authedGet('/api/v1/take-profits/overview');
      expect(overview.body.data.currentLiquidBalance).toBe('420000.0000');
      expect(overview.body.data.availableToWithdraw).toBe('20000.0000');
    });

    it('serializes a working-capital update behind a holder of the cutover lock', async () => {
      await activateCutover({ opening: '500000' });

      const holder = await pool.getConnection();
      try {
        await holder.beginTransaction();
        await new LiquidityRepository().lockCutoverForUpdate(holder);

        let settled = false;
        const pending = Promise.resolve(
          authedPut('/api/v1/take-profits/settings/working-capital', { minWorkingCapital: '450000' }),
        ).then((res) => {
          settled = true;
          return res;
        });
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(settled).toBe(false);

        await holder.commit();
        expect((await pending).status).toBe(200);
      } finally {
        await holder.rollback().catch(() => undefined);
        holder.release();
      }
    });
  });
});
