import type { Express } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
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
});
