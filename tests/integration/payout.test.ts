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

const authedDelete = (url: string) =>
  request(app)
    .delete(url)
    .set('Cookie', `store_sid=${sessionCookie}`)
    .set('X-Requested-With', 'XMLHttpRequest');

describe('Payouts & Ledger API (/api/v1/payouts)', () => {
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
      const res = await request(app).get('/api/v1/payouts/ledgers');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 403 CSRF_REJECTED on POST without header', async () => {
      const res = await request(app)
        .post('/api/v1/payouts/payments')
        .set('Cookie', `store_sid=${sessionCookie}`)
        .send({
          consignorId: 1,
          amount: '10000',
          paymentDate: '2026-03-02',
          paymentMethod: 'cash',
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    });
  });

  describe('Input Validations', () => {
    it('returns 400 when amount is zero or negative', async () => {
      const consignorRes = await authedPost('/api/v1/consignors', {
        name: 'Pak Sani',
        phone: '08123456789',
      });
      const consignorId = consignorRes.body.data.id;

      const resZero = await authedPost('/api/v1/payouts/payments', {
        consignorId,
        amount: '0',
        paymentDate: '2026-03-02',
        paymentMethod: 'cash',
      });
      expect(resZero.status).toBe(400);

      const resNegative = await authedPost('/api/v1/payouts/payments', {
        consignorId,
        amount: '-5000',
        paymentDate: '2026-03-02',
        paymentMethod: 'cash',
      });
      expect(resNegative.status).toBe(400);
    });

    it('returns 404 when consignor does not exist', async () => {
      const res = await authedPost('/api/v1/payouts/payments', {
        consignorId: 99999,
        amount: '50000',
        paymentDate: '2026-03-02',
        paymentMethod: 'cash',
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CONSIGNOR_NOT_FOUND');
    });
  });

  describe('Golden Scenario G9 (Ledger penitip via API)', () => {
    it('accurately transitions across unpaid -> settled -> overpaid and records audit', async () => {
      // 1. Create consignor Pak Sani
      const consignorRes = await authedPost('/api/v1/consignors', {
        name: 'Pak Sani',
        phone: '08123456789',
        defaultMarginType: 'nominal',
        defaultMarginValue: '1000',
      });
      const consignorId = consignorRes.body.data.id;

      // 2. Simulate opname final with 60.000 payout_due
      const [opnameRes] = await pool.execute<ResultSetHeader>(
        `INSERT INTO opnames (opname_date, status, total_turnover, total_sold_qty, total_loss_qty, total_cogs, total_payout_due)
         VALUES ('2026-03-01', 'final', 100000, 20, 0, 0, 60000)`,
      );
      const opnameId = opnameRes.insertId;

      await pool.execute(
        `INSERT INTO opname_consignor_payouts (opname_id, consignor_id, sold_share, loss_compensation, payout_due)
         VALUES (?, ?, 60000, 0, 60000)`,
        [opnameId, consignorId],
      );

      // Step 1: Initial state -> unpaid (balance: 60.000)
      const step1 = await authedGet(`/api/v1/payouts/ledgers/${consignorId}`);
      expect(step1.status).toBe(200);
      expect(step1.body.data.summary.totalAccrual).toBe('60000.0000');
      expect(step1.body.data.summary.totalPayment).toBe('0.0000');
      expect(step1.body.data.summary.balance).toBe('60000.0000');
      expect(step1.body.data.summary.status).toBe('unpaid');
      expect(step1.body.data.accruals).toHaveLength(1);
      expect(step1.body.data.payments).toHaveLength(0);

      // Step 2: Pay 40.000 -> unpaid (balance: 20.000)
      const pay1Res = await authedPost('/api/v1/payouts/payments', {
        consignorId,
        opnameId,
        amount: '40000',
        paymentDate: '2026-03-02',
        paymentMethod: 'cash',
        note: 'Pembayaran bertahap 1',
      });
      expect(pay1Res.status).toBe(201);
      const pay1Id = pay1Res.body.data.id;
      expect(pay1Id).toBeDefined();

      const step2 = await authedGet(`/api/v1/payouts/ledgers/${consignorId}`);
      expect(step2.body.data.summary.totalPayment).toBe('40000.0000');
      expect(step2.body.data.summary.balance).toBe('20000.0000');
      expect(step2.body.data.summary.status).toBe('unpaid');
      expect(step2.body.data.payments).toHaveLength(1);

      // Step 3: Pay 20.000 -> settled (balance: 0)
      const pay2Res = await authedPost('/api/v1/payouts/payments', {
        consignorId,
        opnameId,
        amount: '20000',
        paymentDate: '2026-03-03',
        paymentMethod: 'transfer',
        note: 'Pelunasan',
      });
      expect(pay2Res.status).toBe(201);

      const step3 = await authedGet(`/api/v1/payouts/ledgers/${consignorId}`);
      expect(step3.body.data.summary.totalPayment).toBe('60000.0000');
      expect(step3.body.data.summary.balance).toBe('0.0000');
      expect(step3.body.data.summary.status).toBe('settled');
      expect(step3.body.data.payments).toHaveLength(2);

      // Step 4: Pay 5.000 extra -> overpaid (balance: -5000)
      const pay3Res = await authedPost('/api/v1/payouts/payments', {
        consignorId,
        amount: '5000',
        paymentDate: '2026-03-04',
        paymentMethod: 'qris',
        note: 'Kelebihan bayar / bonus',
      });
      expect(pay3Res.status).toBe(201);
      const pay3Id = pay3Res.body.data.id;

      const step4 = await authedGet(`/api/v1/payouts/ledgers/${consignorId}`);
      expect(step4.body.data.summary.totalPayment).toBe('65000.0000');
      expect(step4.body.data.summary.balance).toBe('-5000.0000');
      expect(step4.body.data.summary.status).toBe('overpaid');
      expect(step4.body.data.payments).toHaveLength(3);

      // Check overview list
      const overviewRes = await authedGet('/api/v1/payouts/ledgers');
      expect(overviewRes.status).toBe(200);
      expect(overviewRes.body.data.totals.totalAccrual).toBe('60000.0000');
      expect(overviewRes.body.data.totals.totalPayment).toBe('65000.0000');
      expect(overviewRes.body.data.totals.totalBalance).toBe('-5000.0000');

      // 5. Delete pay3 (cancel overpayment)
      const delRes = await authedDelete(`/api/v1/payouts/payments/${pay3Id}`);
      expect(delRes.status).toBe(200);

      const afterDelete = await authedGet(`/api/v1/payouts/ledgers/${consignorId}`);
      expect(afterDelete.body.data.summary.balance).toBe('0.0000');
      expect(afterDelete.body.data.summary.status).toBe('settled');

      // Verify audit trail logged created and deleted
      const [auditRows] = await pool.query<RowDataPacket[]>(
        `SELECT action, entity_type, entity_id FROM audit_log WHERE entity_type = 'consignor_payment' ORDER BY id ASC`,
      );
      expect(auditRows.length).toBeGreaterThanOrEqual(4);
      expect(auditRows.some((r) => r.action === 'consignor_payment.created')).toBe(true);
      expect(auditRows.some((r) => r.action === 'consignor_payment.deleted')).toBe(true);
    });
  });
});
