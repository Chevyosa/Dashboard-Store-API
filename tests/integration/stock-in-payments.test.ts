import type { Express } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAdmin } from '../../src/services/admin.service.js';
import { cleanDatabase, createTestPool, getTestEnv } from '../helpers/db.js';

const T0 = new Date('2026-10-04T09:00:00.000Z');
const pool = createTestPool();
const env = getTestEnv();
let app: Express;
let sessionCookie: string;

const KEY_A = '7b1f3c2e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';
const KEY_B = '9c2e4d3f-5b6e-4f7a-9b0c-1d2e3f4a5b6c';
const KEY_C = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

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

const authedGet = (url: string) => request(app).get(url).set('Cookie', `store_sid=${sessionCookie}`);

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

const postPayment = (stockInId: number, key: string | null, body: unknown) => {
  const req = request(app)
    .post(`/api/v1/stock-ins/${stockInId}/payments`)
    .set('Cookie', `store_sid=${sessionCookie}`)
    .set('X-Requested-With', 'XMLHttpRequest');
  if (key !== null) req.set('Idempotency-Key', key);
  return req.send(body as object);
};

async function createProduct(name: string, ownerType: 'own' | 'consignor', consignorId: number | null = null) {
  const res = await authedPost('/api/v1/products', {
    name,
    ownerType,
    consignorId,
    pcsPerPack: 1,
    sellPrice: '5000.0000',
    marginType: ownerType === 'consignor' ? 'nominal' : null,
    marginValue: ownerType === 'consignor' ? '1000.0000' : null,
  });
  return res.body.data.id as number;
}

async function createPurchase(totalCost = '100000.0000'): Promise<number> {
  const productId = await createProduct(`Kopi ${Math.random()}`, 'own');
  const res = await authedPost('/api/v1/stock-ins', {
    type: 'purchase',
    date: '2026-10-04',
    lines: [{ productId, inputMode: 'pcs', qtyPcs: 10, totalCost }],
  });
  expect(res.status).toBe(201);
  return res.body.data.id as number;
}

async function initializeCutover(): Promise<void> {
  await pool.execute(
    `INSERT INTO liquidity_cutover
       (id, opening_amount, cutover_at, opname_high_water_id, stock_in_high_water_id,
        consignor_payment_high_water_id, take_profit_high_water_id)
     VALUES (1, '500000.0000', '2026-10-01 00:00:00.000', 0, 0, 0, 0)`,
  );
}

async function liquidityEvents(): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT event_type, source_type, CAST(source_id AS CHAR) AS source_id, amount_delta,
            DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, created_by
     FROM liquidity_events ORDER BY id ASC`,
  );
  return rows;
}

async function paymentCount(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM stock_in_payments');
  return Number(rows[0]?.n ?? 0);
}

const basePayment = { amount: '40000', paymentDate: '2026-10-05', paymentMethod: 'cash', note: 'DP ke agen' };

describe('Stock-in payments API (/api/v1/stock-ins/:id/payments)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('auth', () => {
    it('rejects POST and GET without a session', async () => {
      const stockInId = await createPurchase();
      const post = await request(app)
        .post(`/api/v1/stock-ins/${stockInId}/payments`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .set('Idempotency-Key', KEY_A)
        .send(basePayment);
      expect(post.status).toBe(401);

      const get = await request(app).get(`/api/v1/stock-ins/${stockInId}/payments`);
      expect(get.status).toBe(401);
      expect(await paymentCount()).toBe(0);
    });
  });

  describe('POST', () => {
    it('records partial settlements and reports paid/outstanding in history', async () => {
      const stockInId = await createPurchase('100000.0000');

      const first = await postPayment(stockInId, KEY_A, basePayment);
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({
        stockInId,
        amount: '40000.0000',
        paymentDate: '2026-10-05',
        paymentMethod: 'cash',
        note: 'DP ke agen',
        idempotencyKey: KEY_A,
      });
      expect(typeof first.body.data.id).toBe('number');

      const second = await postPayment(stockInId, KEY_B, {
        amount: '60000.0000',
        paymentDate: '2026-10-06',
        paymentMethod: 'transfer',
      });
      expect(second.status).toBe(201);
      expect(second.body.data.note).toBeNull();

      const history = await authedGet(`/api/v1/stock-ins/${stockInId}/payments`);
      expect(history.status).toBe(200);
      expect(history.body.data).toMatchObject({
        stockInId,
        receiptTotal: '100000.0000',
        paidAmount: '100000.0000',
        outstandingAmount: '0.0000',
      });
      expect(history.body.data.payments.map((p: { amount: string }) => p.amount)).toEqual([
        '40000.0000',
        '60000.0000',
      ]);

      const [audit] = await pool.query<RowDataPacket[]>(
        `SELECT action, entity_id FROM audit_log WHERE action = 'stock_in_payment.created' ORDER BY id`,
      );
      expect(audit.map((a) => String(a.entity_id))).toEqual([
        String(first.body.data.id),
        String(second.body.data.id),
      ]);
    });

    it('returns an empty history for an unpaid receipt', async () => {
      const stockInId = await createPurchase('25000.5000');
      const history = await authedGet(`/api/v1/stock-ins/${stockInId}/payments`);
      expect(history.status).toBe(200);
      expect(history.body.data).toEqual({
        stockInId,
        receiptTotal: '25000.5000',
        paidAmount: '0.0000',
        outstandingAmount: '25000.5000',
        payments: [],
      });
    });

    it('rejects overpayment beyond the remaining receipt cost', async () => {
      const stockInId = await createPurchase('100000.0000');
      expect((await postPayment(stockInId, KEY_A, { ...basePayment, amount: '70000' })).status).toBe(201);

      const over = await postPayment(stockInId, KEY_B, { ...basePayment, amount: '30000.0001' });
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('PAYMENT_EXCEEDS_OUTSTANDING');

      const exact = await postPayment(stockInId, KEY_C, { ...basePayment, amount: '30000' });
      expect(exact.status).toBe(201);
      expect(await paymentCount()).toBe(2);
    });

    it('rejects payment on a non-purchase stock-in', async () => {
      const consignorRes = await authedPost('/api/v1/consignors', { name: 'Pak Sani', phone: '0812' });
      const productId = await createProduct('Kue Sani', 'consignor', consignorRes.body.data.id);
      const res = await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-04',
        lines: [{ productId, inputMode: 'pcs', qtyPcs: 10 }],
      });
      const pay = await postPayment(res.body.data.id, KEY_A, basePayment);
      expect(pay.status).toBe(400);
      expect(pay.body.error.code).toBe('STOCK_IN_NOT_PURCHASE');
      expect(await paymentCount()).toBe(0);
    });

    it('returns 404 for an unknown stock-in', async () => {
      const pay = await postPayment(999999, KEY_A, basePayment);
      expect(pay.status).toBe(404);
      expect(pay.body.error.code).toBe('STOCK_IN_NOT_FOUND');
      expect((await authedGet('/api/v1/stock-ins/999999/payments')).status).toBe(404);
    });

    it.each([
      ['zero amount', { ...basePayment, amount: '0' }],
      ['negative amount', { ...basePayment, amount: '-100' }],
      ['numeric amount', { ...basePayment, amount: 40000 }],
      ['too many decimals', { ...basePayment, amount: '1.00001' }],
      ['bad date format', { ...basePayment, paymentDate: '05-10-2026' }],
      ['impossible date', { ...basePayment, paymentDate: '2026-02-30' }],
      ['unknown method', { ...basePayment, paymentMethod: 'cheque' }],
      ['missing method', { amount: '100', paymentDate: '2026-10-05' }],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
      const stockInId = await createPurchase();
      const res = await postPayment(stockInId, KEY_A, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await paymentCount()).toBe(0);
    });

    it.each([
      ['missing', null],
      ['not a UUID', 'retry-1'],
    ])('rejects a %s Idempotency-Key', async (_label, key) => {
      const stockInId = await createPurchase();
      const res = await postPayment(stockInId, key, basePayment);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
      expect(await paymentCount()).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('replays the original payment for the same key and equivalent payload', async () => {
      const stockInId = await createPurchase();
      const first = await postPayment(stockInId, KEY_A, basePayment);
      expect(first.status).toBe(201);

      // Same key (different case) and numerically equal amount is the same request.
      const retry = await postPayment(stockInId, KEY_A.toUpperCase(), {
        ...basePayment,
        amount: '40000.0000',
      });
      expect(retry.status).toBe(200);
      expect(retry.body.data).toEqual(first.body.data);
      expect(await paymentCount()).toBe(1);

      const [audit] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'stock_in_payment.created'`,
      );
      expect(Number(audit[0]?.n)).toBe(1);
    });

    it('rejects the same key with a different payload or stock-in with 409', async () => {
      const stockInId = await createPurchase();
      const otherStockInId = await createPurchase();
      expect((await postPayment(stockInId, KEY_A, basePayment)).status).toBe(201);

      for (const [id, body] of [
        [stockInId, { ...basePayment, amount: '40001' }],
        [stockInId, { ...basePayment, paymentMethod: 'qris' }],
        [stockInId, { ...basePayment, paymentDate: '2026-10-07' }],
        [stockInId, { ...basePayment, note: 'lain' }],
        [otherStockInId, basePayment],
      ] as const) {
        const res = await postPayment(id, KEY_A, body);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
      }
      expect(await paymentCount()).toBe(1);
    });

    it('records exactly one payment for concurrent duplicate requests', async () => {
      const stockInId = await createPurchase();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => postPayment(stockInId, KEY_A, basePayment)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 201]);
      const ids = new Set(results.map((r) => r.body.data.id));
      expect(ids.size).toBe(1);
      expect(await paymentCount()).toBe(1);
    });

    it('never overpays under concurrent distinct requests', async () => {
      const stockInId = await createPurchase('100000.0000');
      const results = await Promise.all(
        [KEY_A, KEY_B, KEY_C].map((key) => postPayment(stockInId, key, { ...basePayment, amount: '60000' })),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409]);
      expect(await paymentCount()).toBe(1);
    });
  });

  describe('liquidity ledger', () => {
    it('persists the payment but writes no ledger event before cutover', async () => {
      const stockInId = await createPurchase();
      const res = await postPayment(stockInId, KEY_A, basePayment);
      expect(res.status).toBe(201);
      expect(await paymentCount()).toBe(1);
      expect(await liquidityEvents()).toEqual([]);
    });

    it('appends a negative stock_payment event linked to the payment after cutover', async () => {
      await initializeCutover();
      const stockInId = await createPurchase();
      const res = await postPayment(stockInId, KEY_A, basePayment);
      expect(res.status).toBe(201);

      const events = await liquidityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: 'stock_payment',
        source_type: 'stock_in_payment',
        source_id: String(res.body.data.id),
        amount_delta: '-40000.0000',
        effective_date: '2026-10-05',
      });
      expect(events[0]?.created_by).not.toBeNull();

      // A replay must not append a second event.
      expect((await postPayment(stockInId, KEY_A, basePayment)).status).toBe(200);
      expect(await liquidityEvents()).toHaveLength(1);
    });

    it('records the payment even when it pushes the balance below reserve', async () => {
      await pool.execute(
        `INSERT INTO liquidity_cutover
           (id, opening_amount, cutover_at, opname_high_water_id, stock_in_high_water_id,
            consignor_payment_high_water_id, take_profit_high_water_id)
         VALUES (1, '1000.0000', '2026-10-01 00:00:00.000', 0, 0, 0, 0)`,
      );
      const stockInId = await createPurchase();
      const res = await postPayment(stockInId, KEY_A, { ...basePayment, amount: '90000' });
      expect(res.status).toBe(201);
      expect((await liquidityEvents())[0]?.amount_delta).toBe('-90000.0000');
    });
  });

  describe('stock-in mutation guard', () => {
    it('blocks update and delete once a payment exists', async () => {
      const stockInId = await createPurchase();
      expect((await postPayment(stockInId, KEY_A, basePayment)).status).toBe(201);

      const upd = await authedPut(`/api/v1/stock-ins/${stockInId}`, { note: 'ubah' });
      expect(upd.status).toBe(409);
      expect(upd.body.error.code).toBe('STOCK_IN_HAS_PAYMENTS');

      const del = await authedDelete(`/api/v1/stock-ins/${stockInId}`);
      expect(del.status).toBe(409);
      expect(del.body.error.code).toBe('STOCK_IN_HAS_PAYMENTS');

      expect((await authedGet(`/api/v1/stock-ins/${stockInId}`)).status).toBe(200);
    });

    it('still allows update and delete of an unpaid purchase', async () => {
      const stockInId = await createPurchase();
      expect((await authedPut(`/api/v1/stock-ins/${stockInId}`, { note: 'ubah' })).status).toBe(200);
      expect((await authedDelete(`/api/v1/stock-ins/${stockInId}`)).status).toBe(200);
    });

    it('serializes a delete racing a payment so neither leaves an inconsistent state', async () => {
      const stockInId = await createPurchase();
      const [pay, del] = await Promise.all([
        postPayment(stockInId, KEY_A, basePayment),
        authedDelete(`/api/v1/stock-ins/${stockInId}`),
      ]);
      // Exactly one side wins; the loser is rejected cleanly (no 500).
      const outcome = [pay.status, del.status];
      expect([
        [201, 409],
        [404, 200],
      ]).toContainEqual(outcome);
      if (pay.status === 201) {
        expect(del.body.error.code).toBe('STOCK_IN_HAS_PAYMENTS');
      }
    });
  });
});
