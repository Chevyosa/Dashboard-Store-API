import type { Express } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { LiquidityRepository } from '../../src/repositories/liquidity.repository.js';
import { createAdmin } from '../../src/services/admin.service.js';
import { cleanDatabase, createTestPool, getTestEnv } from '../helpers/db.js';

// Source transactions (opname, stock payment, consignor payment, take-profit,
// purchase stock-in) wired into the liquidity ledger around the one-time cutover.

const T0 = new Date('2026-10-04T09:00:00.000Z');
const pool = createTestPool();
const env = getTestEnv();
let app: Express;
let sessionCookie: string;

// Cutover happens mid-day; its calendar date (2026-10-01) is the cutoff.
const CUTOVER_AT = '2026-10-01 15:00:00.000';
const CUTOFF_DATE = '2026-10-01';
const BEFORE_CUTOFF = '2026-09-30';
const AFTER_CUTOFF = '2026-10-02';

const KEY_A = '7b1f3c2e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';
const KEY_B = '9c2e4d3f-5b6e-4f7a-9b0c-1d2e3f4a5b6c';

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

const postStockPayment = (stockInId: number, key: string, body: unknown) =>
  request(app)
    .post(`/api/v1/stock-ins/${stockInId}/payments`)
    .set('Cookie', `store_sid=${sessionCookie}`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .set('Idempotency-Key', key)
    .send(body as object);

async function maxId(table: string): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT CAST(COALESCE(MAX(id), 0) AS CHAR) AS id FROM ${pool.escapeId(table)}`,
  );
  return String(rows[0]?.id);
}

/**
 * Activates the cutover directly. High-water ids default to 0; pass
 * `captureHighWater` to record the current MAX(id) of opnames/stock_ins, as the
 * real cutover does.
 */
async function activateCutover({ captureHighWater = false } = {}): Promise<void> {
  const opnameHw = captureHighWater ? await maxId('opnames') : '0';
  const stockInHw = captureHighWater ? await maxId('stock_ins') : '0';
  await pool.execute(
    `INSERT INTO liquidity_cutover
       (id, opening_amount, cutover_at, opname_high_water_id, stock_in_high_water_id,
        consignor_payment_high_water_id, take_profit_high_water_id)
     VALUES (1, '500000.0000', ?, CAST(? AS UNSIGNED), CAST(? AS UNSIGNED), 0, 0)`,
    [CUTOVER_AT, opnameHw, stockInHw],
  );
  // The cutover seeds the ledger with its opening cash, as the real cutover does.
  await pool.execute(
    `INSERT INTO liquidity_events (event_type, source_type, source_id, amount_delta, effective_date)
     VALUES ('opening', 'cutover', 1, '500000.0000', ?)`,
    [CUTOFF_DATE],
  );
}

/** Ledger events written by source hooks; the cutover's own opening event is excluded. */
async function liquidityEvents(): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT event_type, source_type, CAST(source_id AS CHAR) AS source_id, amount_delta,
            DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, created_by
     FROM liquidity_events WHERE event_type <> 'opening' ORDER BY id ASC`,
  );
  return rows;
}

async function countRows(table: string, where = '1 = 1'): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM ${pool.escapeId(table)} WHERE ${where}`,
  );
  return Number(rows[0]?.n ?? 0);
}

const auditCount = (action: string) => countRows('audit_log', `action = ${pool.escape(action)}`);

async function createOwnProduct(): Promise<number> {
  const res = await authedPost('/api/v1/products', {
    name: `Gery ${Math.random()}`,
    ownerType: 'own',
    consignorId: null,
    pcsPerPack: 1,
    sellPrice: '1500.0000',
    marginType: null,
    marginValue: null,
  });
  expect(res.status).toBe(201);
  return res.body.data.id as number;
}

async function createPurchase(date: string, totalCost = '10000.0000', productId?: number) {
  const id = productId ?? (await createOwnProduct());
  return authedPost('/api/v1/stock-ins', {
    type: 'purchase',
    date,
    lines: [{ productId: id, inputMode: 'pcs', qtyPcs: 10, totalCost }],
  });
}

/** 10 pcs bought before the cutoff, so any later opname date can count them. */
async function seedStock(): Promise<number> {
  const productId = await createOwnProduct();
  const res = await createPurchase(BEFORE_CUTOFF, '10000.0000', productId);
  expect(res.status).toBe(201);
  return productId;
}

const finalize = (productId: number, opnameDate: string, cashAmount = '8000.0000', qrisAmount = '2500.0000') =>
  authedPost('/api/v1/opnames/finalize', {
    opnameDate,
    items: [{ productId, physicalQty: 3 }],
    cashAmount,
    qrisAmount,
  });

async function createConsignor(): Promise<number> {
  const res = await authedPost('/api/v1/consignors', { name: `Pak Sani ${Math.random()}`, phone: '0812' });
  expect(res.status).toBe(201);
  return res.body.data.id as number;
}

const payConsignor = (consignorId: number, paymentDate: string, amount = '40000') =>
  authedPost('/api/v1/payouts/payments', { consignorId, amount, paymentDate, paymentMethod: 'cash' });

const takeProfit = (withdrawalDate: string, amount = '75000') =>
  authedPost('/api/v1/take-profits', { amount, withdrawalDate, paymentMethod: 'cash' });

const injectEventFailure = () =>
  vi
    .spyOn(LiquidityRepository.prototype, 'appendEvent')
    .mockRejectedValueOnce(new Error('injected liquidity_events failure'));

describe('Liquidity ledger wiring of source transactions', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('before cutover', () => {
    it('keeps current behavior and writes no ledger events for any source', async () => {
      const productId = await seedStock();
      // Dates on/before the would-be cutoff are fine while no cutover exists.
      expect((await finalize(productId, CUTOFF_DATE)).status).toBe(201);

      const consignorId = await createConsignor();
      const payout = await payConsignor(consignorId, BEFORE_CUTOFF);
      expect(payout.status).toBe(201);

      const tp = await takeProfit(BEFORE_CUTOFF);
      expect(tp.status).toBe(201);

      const purchase = await createPurchase(BEFORE_CUTOFF);
      expect(purchase.status).toBe(201);
      const pay = await postStockPayment(purchase.body.data.id, KEY_A, {
        amount: '1000',
        paymentDate: BEFORE_CUTOFF,
        paymentMethod: 'cash',
      });
      expect(pay.status).toBe(201);

      expect(await liquidityEvents()).toEqual([]);

      // Deletes keep working before cutover.
      expect((await authedDelete(`/api/v1/payouts/payments/${payout.body.data.id}`)).status).toBe(200);
      expect((await authedDelete(`/api/v1/take-profits/${tp.body.data.id}`)).status).toBe(200);
      expect(await countRows('consignor_payments')).toBe(0);
      expect(await countRows('take_profits')).toBe(0);
      expect(await auditCount('consignor_payment.deleted')).toBe(1);
      expect(await auditCount('take_profit.deleted')).toBe(1);
    });

    it('acquires the common cutover lock for every source write', async () => {
      const lockSpy = vi.spyOn(LiquidityRepository.prototype, 'lockCutoverForUpdate');
      const expectLocked = async (label: string, run: () => Promise<request.Response>, status: number) => {
        lockSpy.mockClear();
        const res = await run();
        expect(res.status, label).toBe(status);
        expect(lockSpy, label).toHaveBeenCalledTimes(1);
        return res;
      };

      const productId = await createOwnProduct();
      const purchase = await expectLocked('stock-in create', () => createPurchase(BEFORE_CUTOFF, '10000.0000', productId), 201);
      const stockInId = purchase.body.data.id as number;
      await expectLocked('stock-in update', () => authedPut(`/api/v1/stock-ins/${stockInId}`, { note: 'x' }), 200);
      await expectLocked('stock-in delete', () => authedDelete(`/api/v1/stock-ins/${stockInId}`), 200);

      const other = await createPurchase(BEFORE_CUTOFF, '10000.0000', productId);
      await expectLocked(
        'stock payment',
        () =>
          postStockPayment(other.body.data.id, KEY_A, {
            amount: '500',
            paymentDate: BEFORE_CUTOFF,
            paymentMethod: 'cash',
          }),
        201,
      );

      // Draft saves serialize with the cutover too, so no draft can slip past
      // its open-draft check.
      await expectLocked(
        'opname draft save',
        () =>
          authedPost('/api/v1/opnames/draft', {
            opnameDate: CUTOFF_DATE,
            items: [{ productId, physicalQty: 3 }],
          }),
        200,
      );
      await expectLocked('opname finalize', () => finalize(productId, CUTOFF_DATE), 201);

      const consignorId = await createConsignor();
      const payout = await expectLocked('payout create', () => payConsignor(consignorId, BEFORE_CUTOFF), 201);
      await expectLocked('payout delete', () => authedDelete(`/api/v1/payouts/payments/${payout.body.data.id}`), 200);

      const tp = await expectLocked('take-profit create', () => takeProfit(BEFORE_CUTOFF), 201);
      await expectLocked('take-profit delete', () => authedDelete(`/api/v1/take-profits/${tp.body.data.id}`), 200);
      // The withdrawal reserve feeds the take-profit guard, so its writes serialize too.
      await expectLocked(
        'working capital update',
        () => authedPut('/api/v1/take-profits/settings/working-capital', { minWorkingCapital: '300000' }),
        200,
      );
    });
  });

  describe('opname finalization after cutover', () => {
    it('rejects a new draft dated on or before cutover after initialization', async () => {
      const productId = await seedStock();
      await activateCutover();

      const res = await authedPost('/api/v1/opnames/draft', {
        opnameDate: CUTOFF_DATE,
        items: [{ productId, physicalQty: 3 }],
        cashAmount: '7000.0000',
        qrisAmount: '3000.0000',
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');
      expect(await countRows('opnames')).toBe(0);
      expect(await auditCount('opname.draft_saved')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });

    it('adds one positive opname_inflow for gross realCash in the same transaction', async () => {
      const productId = await seedStock();
      await activateCutover();

      const res = await finalize(productId, AFTER_CUTOFF, '8000.0000', '2500.0000');
      expect(res.status).toBe(201);
      expect(res.body.data.realCash).toBe('10500.0000');

      const events = await liquidityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: 'opname_inflow',
        source_type: 'opname',
        source_id: String(res.body.data.id),
        amount_delta: '10500.0000',
        effective_date: AFTER_CUTOFF,
      });
      expect(events[0]?.created_by).not.toBeNull();
      expect(await auditCount('opname.finalized')).toBe(1);
    });

    it('adds nothing for a draft save, then exactly one event when that draft is finalized', async () => {
      const productId = await seedStock();
      await activateCutover();

      const draft = await authedPost('/api/v1/opnames/draft', {
        opnameDate: AFTER_CUTOFF,
        items: [{ productId, physicalQty: 3 }],
        cashAmount: '7000.0000',
        qrisAmount: '3000.0000',
      });
      expect(draft.status).toBe(200);
      expect(await liquidityEvents()).toEqual([]);

      const final = await finalize(productId, AFTER_CUTOFF);
      expect(final.status).toBe(201);
      expect(final.body.data.id).toBe(draft.body.data.id);
      const events = await liquidityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ source_id: String(draft.body.data.id), amount_delta: '10500.0000' });
    });

    it('adds no event when realCash is zero', async () => {
      const productId = await seedStock();
      await activateCutover();

      const res = await finalize(productId, AFTER_CUTOFF, '0', '0');
      expect(res.status).toBe(201);
      expect(res.body.data.realCash).toBe('0.0000');
      expect(await liquidityEvents()).toEqual([]);
    });

    it.each([
      ['on the cutoff date', CUTOFF_DATE],
      ['before the cutoff date', BEFORE_CUTOFF],
    ])('rejects a finalization dated %s with 409 and persists nothing', async (_label, date) => {
      const productId = await seedStock();
      await activateCutover();

      const res = await finalize(productId, date);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');
      expect(await countRows('opnames')).toBe(0);
      expect(await countRows('stock_ins', 'opname_id IS NOT NULL')).toBe(0);
      expect(await auditCount('opname.finalized')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });

    it('never replays the inflow when finalization is retried', async () => {
      const productId = await seedStock();
      await activateCutover();

      expect((await finalize(productId, AFTER_CUTOFF)).status).toBe(201);
      const retry = await finalize(productId, AFTER_CUTOFF);
      expect(retry.status).toBe(409);
      expect(retry.body.error.code).toBe('PERIOD_ALREADY_FINALIZED');

      const concurrent = await Promise.all([finalize(productId, '2026-10-03'), finalize(productId, '2026-10-03')]);
      expect(concurrent.map((r) => r.status).sort()).toEqual([201, 409]);

      const events = await liquidityEvents();
      expect(events.map((e) => e.event_type)).toEqual(['opname_inflow', 'opname_inflow']);
      expect(new Set(events.map((e) => e.source_id)).size).toBe(2);
    });

    it('rejects finalizing a preexisting draft at or below the high-water id even when dated after the cutoff', async () => {
      const productId = await seedStock();
      const draft = await authedPost('/api/v1/opnames/draft', {
        opnameDate: AFTER_CUTOFF,
        items: [{ productId, physicalQty: 3 }],
        cashAmount: '7000.0000',
        qrisAmount: '3000.0000',
      });
      expect(draft.status).toBe(200);
      await activateCutover({ captureHighWater: true });
      expect(await maxId('opnames')).toBe(String(draft.body.data.id));

      const res = await finalize(productId, AFTER_CUTOFF);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');
      expect(await countRows('opnames', `status = 'draft'`)).toBe(1);
      expect(await countRows('opnames', `status = 'final'`)).toBe(0);
      expect(await countRows('stock_ins', 'opname_id IS NOT NULL')).toBe(0);
      expect(await auditCount('opname.finalized')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });

    it('still allows a new opname above the high-water id dated after the cutoff', async () => {
      const productId = await seedStock();
      expect((await finalize(productId, BEFORE_CUTOFF)).status).toBe(201);
      await activateCutover({ captureHighWater: true });
      expect(await maxId('opnames')).not.toBe('0');

      const onCutoff = await finalize(productId, CUTOFF_DATE);
      expect(onCutoff.status).toBe(409);
      expect(onCutoff.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');

      const res = await finalize(productId, AFTER_CUTOFF);
      expect(res.status).toBe(201);
      expect(await liquidityEvents()).toHaveLength(1);
    });

    it('rolls back the finalization and audit entry if the event insert fails', async () => {
      const productId = await seedStock();
      await activateCutover();
      injectEventFailure();

      const res = await finalize(productId, AFTER_CUTOFF);
      expect(res.status).toBe(500);
      expect(await countRows('opnames')).toBe(0);
      expect(await countRows('stock_ins', 'opname_id IS NOT NULL')).toBe(0);
      expect(await auditCount('opname.finalized')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });
  });

  describe('consignor payment after cutover', () => {
    it('adds one negative consignor_payment event and audits it in the same transaction', async () => {
      const consignorId = await createConsignor();
      await activateCutover();

      const res = await payConsignor(consignorId, AFTER_CUTOFF, '40000.5000');
      expect(res.status).toBe(201);

      const events = await liquidityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: 'consignor_payment',
        source_type: 'consignor_payment',
        source_id: String(res.body.data.id),
        amount_delta: '-40000.5000',
        effective_date: AFTER_CUTOFF,
      });
      expect(await auditCount('consignor_payment.created')).toBe(1);
    });

    it.each([
      ['on the cutoff date', CUTOFF_DATE],
      ['before the cutoff date', BEFORE_CUTOFF],
    ])('rejects a payment dated %s with 409', async (_label, date) => {
      const consignorId = await createConsignor();
      await activateCutover();

      const res = await payConsignor(consignorId, date);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');
      expect(await countRows('consignor_payments')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });

    it('rejects deletes after cutover to keep the ledger append-only', async () => {
      const consignorId = await createConsignor();
      const legacy = await payConsignor(consignorId, BEFORE_CUTOFF);
      await activateCutover();
      const fresh = await payConsignor(consignorId, AFTER_CUTOFF);

      for (const id of [legacy.body.data.id, fresh.body.data.id]) {
        const del = await authedDelete(`/api/v1/payouts/payments/${id}`);
        expect(del.status).toBe(409);
        expect(del.body.error.code).toBe('LIQUIDITY_HISTORY_LOCKED');
      }
      expect(await countRows('consignor_payments')).toBe(2);
      expect(await liquidityEvents()).toHaveLength(1);
      expect(await auditCount('consignor_payment.deleted')).toBe(0);

      expect((await authedDelete('/api/v1/payouts/payments/999999')).status).toBe(404);
    });

    it('rolls back the payment and audit entry if the event insert fails', async () => {
      const consignorId = await createConsignor();
      await activateCutover();
      injectEventFailure();

      const res = await payConsignor(consignorId, AFTER_CUTOFF);
      expect(res.status).toBe(500);
      expect(await countRows('consignor_payments')).toBe(0);
      expect(await auditCount('consignor_payment.created')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });
  });

  describe('take-profit after cutover', () => {
    it('adds one negative owner_withdrawal event and audits it in the same transaction', async () => {
      await activateCutover();

      const res = await takeProfit(AFTER_CUTOFF, '75000.2500');
      expect(res.status).toBe(201);

      const events = await liquidityEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: 'owner_withdrawal',
        source_type: 'take_profit',
        source_id: String(res.body.data.id),
        amount_delta: '-75000.2500',
        effective_date: AFTER_CUTOFF,
      });
      expect(await auditCount('take_profit.created')).toBe(1);
    });

    it.each([
      ['on the cutoff date', CUTOFF_DATE],
      ['before the cutoff date', BEFORE_CUTOFF],
    ])('rejects a withdrawal dated %s with 409', async (_label, date) => {
      await activateCutover();

      const res = await takeProfit(date);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');
      expect(await countRows('take_profits')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });

    it('rejects deletes after cutover to keep the ledger append-only', async () => {
      const legacy = await takeProfit(BEFORE_CUTOFF);
      await activateCutover();
      const fresh = await takeProfit(AFTER_CUTOFF);

      for (const id of [legacy.body.data.id, fresh.body.data.id]) {
        const del = await authedDelete(`/api/v1/take-profits/${id}`);
        expect(del.status).toBe(409);
        expect(del.body.error.code).toBe('LIQUIDITY_HISTORY_LOCKED');
      }
      expect(await countRows('take_profits')).toBe(2);
      expect(await liquidityEvents()).toHaveLength(1);
      expect(await auditCount('take_profit.deleted')).toBe(0);

      expect((await authedDelete('/api/v1/take-profits/999999')).status).toBe(404);
    });

    it('rolls back the withdrawal and audit entry if the event insert fails', async () => {
      await activateCutover();
      injectEventFailure();

      const res = await takeProfit(AFTER_CUTOFF);
      expect(res.status).toBe(500);
      expect(await countRows('take_profits')).toBe(0);
      expect(await auditCount('take_profit.created')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });
  });

  describe('stock payment after cutover', () => {
    it.each([
      ['on the cutoff date', CUTOFF_DATE],
      ['before the cutoff date', BEFORE_CUTOFF],
    ])('rejects a payment dated %s with 409', async (_label, date) => {
      const purchase = await createPurchase(BEFORE_CUTOFF);
      await activateCutover();

      const res = await postStockPayment(purchase.body.data.id, KEY_A, {
        amount: '1000',
        paymentDate: date,
        paymentMethod: 'cash',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');
      expect(await countRows('stock_in_payments')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });

    it('rolls back the payment and audit entry if the event insert fails', async () => {
      const purchase = await createPurchase(BEFORE_CUTOFF);
      await activateCutover();
      injectEventFailure();

      const res = await postStockPayment(purchase.body.data.id, KEY_B, {
        amount: '1000',
        paymentDate: AFTER_CUTOFF,
        paymentMethod: 'cash',
      });
      expect(res.status).toBe(500);
      expect(await countRows('stock_in_payments')).toBe(0);
      expect(await auditCount('stock_in_payment.created')).toBe(0);
      expect(await liquidityEvents()).toEqual([]);
    });
  });

  describe('purchase stock-in after cutover', () => {
    it.each([
      ['on the cutoff date', CUTOFF_DATE],
      ['before the cutoff date', BEFORE_CUTOFF],
    ])('rejects a purchase receipt dated %s with 409', async (_label, date) => {
      const productId = await createOwnProduct();
      await activateCutover();

      const res = await createPurchase(date, '10000.0000', productId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');
      expect(await countRows('stock_ins')).toBe(0);
    });

    it('accepts a purchase dated after the cutoff and non-purchase receipts on the cutoff', async () => {
      const productId = await createOwnProduct();
      await activateCutover();

      expect((await createPurchase(AFTER_CUTOFF, '10000.0000', productId)).status).toBe(201);
      const initial = await authedPost('/api/v1/stock-ins', {
        type: 'initial',
        date: CUTOFF_DATE,
        lines: [{ productId, inputMode: 'pcs', qtyPcs: 5, totalCost: '0' }],
      });
      expect(initial.status).toBe(201);
    });

    it('rejects moving a purchase onto/before the cutoff, and editing or deleting a pre-cutoff purchase', async () => {
      const productId = await createOwnProduct();
      const legacy = await createPurchase(BEFORE_CUTOFF, '10000.0000', productId);
      await activateCutover();
      const fresh = await createPurchase(AFTER_CUTOFF, '10000.0000', productId);

      const moved = await authedPut(`/api/v1/stock-ins/${fresh.body.data.id}`, { date: CUTOFF_DATE });
      expect(moved.status).toBe(409);
      expect(moved.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');

      const editLegacy = await authedPut(`/api/v1/stock-ins/${legacy.body.data.id}`, { note: 'ubah' });
      expect(editLegacy.status).toBe(409);
      expect(editLegacy.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');

      const delLegacy = await authedDelete(`/api/v1/stock-ins/${legacy.body.data.id}`);
      expect(delLegacy.status).toBe(409);
      expect(delLegacy.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');

      // A post-cutoff purchase stays editable and deletable.
      expect((await authedPut(`/api/v1/stock-ins/${fresh.body.data.id}`, { note: 'ok' })).status).toBe(200);
      expect((await authedDelete(`/api/v1/stock-ins/${fresh.body.data.id}`)).status).toBe(200);
      expect(await countRows('stock_ins')).toBe(1);
    });

    it('rejects editing or deleting a purchase at or below the high-water id even when dated after the cutoff', async () => {
      const productId = await createOwnProduct();
      // Recorded before the cutover existed, with a future business date.
      const legacy = await createPurchase(AFTER_CUTOFF, '10000.0000', productId);
      expect(legacy.status).toBe(201);
      await activateCutover({ captureHighWater: true });
      expect(await maxId('stock_ins')).toBe(String(legacy.body.data.id));

      const edit = await authedPut(`/api/v1/stock-ins/${legacy.body.data.id}`, { note: 'ubah' });
      expect(edit.status).toBe(409);
      expect(edit.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');

      const moveLater = await authedPut(`/api/v1/stock-ins/${legacy.body.data.id}`, { date: '2026-10-05' });
      expect(moveLater.status).toBe(409);
      expect(moveLater.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');

      const del = await authedDelete(`/api/v1/stock-ins/${legacy.body.data.id}`);
      expect(del.status).toBe(409);
      expect(del.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');

      expect(await countRows('stock_ins')).toBe(1);
      expect(await countRows('stock_ins', `note IS NULL AND date = ${pool.escape(AFTER_CUTOFF)}`)).toBe(1);
      expect(await auditCount('stock_in.updated')).toBe(0);
      expect(await auditCount('stock_in.deleted')).toBe(0);
    });

    it('keeps a purchase above the high-water id editable while its date stays after the cutoff', async () => {
      const productId = await createOwnProduct();
      expect((await createPurchase(BEFORE_CUTOFF, '10000.0000', productId)).status).toBe(201);
      await activateCutover({ captureHighWater: true });
      const fresh = await createPurchase(AFTER_CUTOFF, '10000.0000', productId);
      expect(fresh.status).toBe(201);

      const moved = await authedPut(`/api/v1/stock-ins/${fresh.body.data.id}`, { date: CUTOFF_DATE });
      expect(moved.status).toBe(409);
      expect(moved.body.error.code).toBe('BEFORE_LIQUIDITY_CUTOVER');

      expect((await authedPut(`/api/v1/stock-ins/${fresh.body.data.id}`, { note: 'ok' })).status).toBe(200);
      expect((await authedDelete(`/api/v1/stock-ins/${fresh.body.data.id}`)).status).toBe(200);
    });

    it('leaves non-purchase receipts at or below the high-water id editable and deletable', async () => {
      const productId = await createOwnProduct();
      const initial = await authedPost('/api/v1/stock-ins', {
        type: 'initial',
        date: BEFORE_CUTOFF,
        lines: [{ productId, inputMode: 'pcs', qtyPcs: 5, totalCost: '0' }],
      });
      expect(initial.status).toBe(201);
      await activateCutover({ captureHighWater: true });
      expect(await maxId('stock_ins')).toBe(String(initial.body.data.id));

      expect((await authedPut(`/api/v1/stock-ins/${initial.body.data.id}`, { note: 'ok' })).status).toBe(200);
      expect((await authedDelete(`/api/v1/stock-ins/${initial.body.data.id}`)).status).toBe(200);
    });
  });

  describe('serialization on the cutover lock', () => {
    type Send = () => PromiseLike<request.Response>;
    it.each<[string, () => Promise<Send>, number, number]>([
      ['opname finalization', async () => {
        const productId = await seedStock();
        return () => finalize(productId, AFTER_CUTOFF);
      }, 201, 1],
      ['consignor payment', async () => {
        const consignorId = await createConsignor();
        return () => payConsignor(consignorId, AFTER_CUTOFF);
      }, 201, 1],
      ['take-profit', () => Promise.resolve(() => takeProfit(AFTER_CUTOFF)), 201, 1],
      ['purchase stock-in create', async () => {
        const productId = await createOwnProduct();
        return () => createPurchase(AFTER_CUTOFF, '10000.0000', productId);
      }, 201, 0],
      ['stock payment', async () => {
        const purchase = await createPurchase(BEFORE_CUTOFF);
        return () =>
          postStockPayment(purchase.body.data.id, KEY_A, {
            amount: '1000',
            paymentDate: AFTER_CUTOFF,
            paymentMethod: 'cash',
          });
      }, 201, 1],
    ])('%s waits for a concurrent holder of the cutover lock', async (_label, prepare, status, eventCount) => {
      const send = await prepare();
      await activateCutover();

      const holder = await pool.getConnection();
      try {
        await holder.beginTransaction();
        await new LiquidityRepository().lockCutoverForUpdate(holder);

        let settled = false;
        const pending = Promise.resolve(send()).then((res) => {
          settled = true;
          return res;
        });
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(settled).toBe(false);

        await holder.commit();
        const res = await pending;
        expect(res.status).toBe(status);
        expect(await liquidityEvents()).toHaveLength(eventCount);
      } finally {
        await holder.rollback().catch(() => undefined);
        holder.release();
      }
    });
  });
});
