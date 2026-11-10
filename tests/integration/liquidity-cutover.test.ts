import type { Express } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import {
  isAtOrBelowHighWater,
  LiquidityRepository,
} from '../../src/repositories/liquidity.repository.js';
import { createAdmin } from '../../src/services/admin.service.js';
import { cleanDatabase, createTestPool, getTestEnv } from '../helpers/db.js';

// One-time cutover initialization: POST /api/v1/liquidity/cutover.

const T0 = new Date('2026-10-04T09:00:00.000Z');
const CUTOVER_AT = '2026-10-04 09:00:00.000';
const CUTOVER_DATE = '2026-10-04';
const BEFORE_CUTOFF = '2026-10-03';
// Above 2^53, so a lossy JS number would be visible.
const HUGE_TAKE_PROFIT_ID = '9007199254740993';

const KEY_A = '7b1f3c2e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';

const pool = createTestPool();
const env = getTestEnv();
let app: Express;
let sessionCookie: string;
let adminId: number;

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

const validBody = {
  openingAmount: '1250000.5',
  openingUnpaidStock: '300000',
  confirmOpeningBalance: true,
  confirmLegacyPurchasesReconciled: true,
};

const postCutover = (body: unknown = validBody) => authedPost('/api/v1/liquidity/cutover', body);

async function countRows(table: string, where = '1 = 1'): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM ${pool.escapeId(table)} WHERE ${where}`,
  );
  return Number(rows[0]?.n ?? 0);
}

const auditCount = () => countRows('audit_log', `action = 'liquidity.cutover_initialized'`);

async function cutoverRows(): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT opening_amount, opening_unpaid_stock,
            DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s.%f') AS cutover_at,
            CAST(opname_high_water_id AS CHAR) AS opname_hw,
            CAST(stock_in_high_water_id AS CHAR) AS stock_in_hw,
            CAST(stock_in_payment_high_water_id AS CHAR) AS stock_in_payment_hw,
            CAST(consignor_payment_high_water_id AS CHAR) AS consignor_payment_hw,
            CAST(take_profit_high_water_id AS CHAR) AS take_profit_hw,
            created_by
     FROM liquidity_cutover`,
  );
  return rows;
}

async function liquidityEvents(): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT event_type, source_type, CAST(source_id AS CHAR) AS source_id, amount_delta,
            DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, created_by
     FROM liquidity_events ORDER BY id ASC`,
  );
  return rows;
}

async function minWorkingCapitalSnapshot(): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT setting_key, setting_value FROM store_settings ORDER BY setting_key',
  );
  return JSON.stringify(rows);
}

async function maxId(table: string): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT CAST(COALESCE(MAX(id), 0) AS CHAR) AS id FROM ${pool.escapeId(table)}`,
  );
  return String(rows[0]?.id);
}

/** Creates at least one row in every high-water source table, before any cutover. */
async function seedPreCutoverSources(): Promise<void> {
  const product = await authedPost('/api/v1/products', {
    name: 'Kopi Sachet',
    ownerType: 'own',
    consignorId: null,
    pcsPerPack: 1,
    sellPrice: '1500.0000',
    marginType: null,
    marginValue: null,
  });
  expect(product.status).toBe(201);
  const productId = product.body.data.id as number;

  for (let i = 0; i < 2; i++) {
    const purchase = await authedPost('/api/v1/stock-ins', {
      type: 'purchase',
      date: BEFORE_CUTOFF,
      lines: [{ productId, inputMode: 'pcs', qtyPcs: 10, totalCost: '10000.0000' }],
    });
    expect(purchase.status).toBe(201);
  }
  const stockInId = Number(await maxId('stock_ins'));

  const pay = await request(app)
    .post(`/api/v1/stock-ins/${stockInId}/payments`)
    .set('Cookie', `store_sid=${sessionCookie}`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .set('Idempotency-Key', KEY_A)
    .send({ amount: '1000', paymentDate: BEFORE_CUTOFF, paymentMethod: 'cash' });
  expect(pay.status).toBe(201);

  const opname = await authedPost('/api/v1/opnames/finalize', {
    opnameDate: BEFORE_CUTOFF,
    items: [{ productId, physicalQty: 3 }],
    cashAmount: '8000.0000',
    qrisAmount: '2500.0000',
  });
  expect(opname.status).toBe(201);

  const consignor = await authedPost('/api/v1/consignors', { name: 'Pak Sani', phone: '0812' });
  expect(consignor.status).toBe(201);
  const payout = await authedPost('/api/v1/payouts/payments', {
    consignorId: consignor.body.data.id,
    amount: '40000',
    paymentDate: BEFORE_CUTOFF,
    paymentMethod: 'cash',
  });
  expect(payout.status).toBe(201);

  await pool.execute(
    `INSERT INTO take_profits (id, amount, withdrawal_date, payment_method)
     VALUES (CAST(? AS UNSIGNED), '5000.0000', ?, 'cash')`,
    [HUGE_TAKE_PROFIT_ID, BEFORE_CUTOFF],
  );
}

describe('isAtOrBelowHighWater', () => {
  it.each<[string | number, string, boolean]>([
    ['1', '0', false],
    [1, '1', true],
    ['5', '10', true],
    [11, '10', false],
    // Neighbours above 2^53 collapse to the same JS number; BigInt keeps them apart.
    ['9007199254740993', '9007199254740992', false],
    ['9007199254740992', '9007199254740993', true],
    ['9007199254740993', '9007199254740993', true],
    ['18446744073709551615', '18446744073709551614', false],
  ])('source %s vs high-water %s -> %s', (sourceId, highWater, expected) => {
    expect(isAtOrBelowHighWater(sourceId, highWater)).toBe(expected);
  });

  it.each<[string, string | number, string]>([
    ['zero source id', '0', '5'],
    ['zero numeric source id', 0, '5'],
    ['negative source id', -1, '5'],
    ['fractional source id', 1.5, '5'],
    ['unsafe numeric source id', 2 ** 53, '5'],
    ['source id above BIGINT UNSIGNED max', '18446744073709551616', '5'],
    ['high-water above BIGINT UNSIGNED max', '5', '18446744073709551616'],
    ['leading zero source id', '05', '5'],
    ['leading zero high-water id', '5', '05'],
    ['signed string', '+5', '5'],
    ['exponent string', '1e3', '5'],
    ['empty string', '', '5'],
    ['malformed high-water', '5', 'abc'],
    ['negative high-water', '5', '-1'],
  ])('rejects a %s', (_label, sourceId, highWater) => {
    expect(() => isAtOrBelowHighWater(sourceId, highWater)).toThrow();
  });
});

describe('Liquidity cutover initialization API (POST /api/v1/liquidity/cutover)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
    await pool.execute(
      `INSERT INTO store_settings (setting_key, setting_value) VALUES ('min_working_capital', '400000.0000')`,
    );
    const [users] = await pool.query<RowDataPacket[]>(`SELECT id FROM users WHERE username = 'owner'`);
    adminId = Number(users[0]?.id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('auth and CSRF', () => {
    it('rejects a request without a session', async () => {
      const res = await request(app)
        .post('/api/v1/liquidity/cutover')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send(validBody);
      expect(res.status).toBe(401);
      expect(await countRows('liquidity_cutover')).toBe(0);
    });

    it('rejects a session request without the CSRF header', async () => {
      const res = await request(app)
        .post('/api/v1/liquidity/cutover')
        .set('Cookie', `store_sid=${sessionCookie}`)
        .send(validBody);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
      expect(await countRows('liquidity_cutover')).toBe(0);
    });
  });

  describe('validation', () => {
    const invalidBodies: [string, unknown][] = [
      ['missing confirmOpeningBalance', { ...validBody, confirmOpeningBalance: undefined }],
      ['false confirmOpeningBalance', { ...validBody, confirmOpeningBalance: false }],
      ['string confirmOpeningBalance', { ...validBody, confirmOpeningBalance: 'true' }],
      ['missing confirmLegacyPurchasesReconciled', { ...validBody, confirmLegacyPurchasesReconciled: undefined }],
      ['false confirmLegacyPurchasesReconciled', { ...validBody, confirmLegacyPurchasesReconciled: false }],
      ['missing openingAmount', { ...validBody, openingAmount: undefined }],
      ['zero openingAmount', { ...validBody, openingAmount: '0' }],
      ['negative openingAmount', { ...validBody, openingAmount: '-5' }],
      ['malformed openingAmount', { ...validBody, openingAmount: '1e5' }],
      ['too many decimals', { ...validBody, openingAmount: '1.00001' }],
      ['missing openingUnpaidStock', { ...validBody, openingUnpaidStock: undefined }],
      ['negative openingUnpaidStock', { ...validBody, openingUnpaidStock: '-1' }],
      ['unknown field', { ...validBody, cutoverAt: '2020-01-01 00:00:00' }],
    ];

    it.each(invalidBodies)('rejects %s without writing anything', async (_label, body) => {
      const res = await postCutover(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await countRows('liquidity_cutover')).toBe(0);
      expect(await countRows('liquidity_events')).toBe(0);
      expect(await auditCount()).toBe(0);
    });

    it('accepts a zero openingUnpaidStock', async () => {
      const res = await postCutover({ ...validBody, openingUnpaidStock: '0' });
      expect(res.status).toBe(201);
      expect(res.body.data.openingUnpaidStock).toBe('0.0000');
    });
  });

  describe('initialization', () => {
    it('captures preexisting high-water marks and writes one row, one opening event and one audit', async () => {
      await seedPreCutoverSources();
      const expected = {
        opnameHighWaterId: await maxId('opnames'),
        stockInHighWaterId: await maxId('stock_ins'),
        stockInPaymentHighWaterId: await maxId('stock_in_payments'),
        consignorPaymentHighWaterId: await maxId('consignor_payments'),
        takeProfitHighWaterId: HUGE_TAKE_PROFIT_ID,
      };
      for (const v of Object.values(expected)) expect(v).not.toBe('0');
      expect(expected.stockInHighWaterId).toBe('2');
      const settingsBefore = await minWorkingCapitalSnapshot();

      const res = await postCutover();
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        openingAmount: '1250000.5000',
        openingUnpaidStock: '300000.0000',
        cutoverAt: CUTOVER_AT,
        ...expected,
        createdBy: adminId,
        createdAt: expect.any(String),
      });

      expect(await cutoverRows()).toEqual([
        {
          opening_amount: '1250000.5000',
          opening_unpaid_stock: '300000.0000',
          cutover_at: `${CUTOVER_AT}000`,
          opname_hw: expected.opnameHighWaterId,
          stock_in_hw: expected.stockInHighWaterId,
          stock_in_payment_hw: expected.stockInPaymentHighWaterId,
          consignor_payment_hw: expected.consignorPaymentHighWaterId,
          take_profit_hw: HUGE_TAKE_PROFIT_ID,
          created_by: adminId,
        },
      ]);

      expect(await liquidityEvents()).toEqual([
        {
          event_type: 'opening',
          source_type: 'cutover',
          source_id: '1',
          amount_delta: '1250000.5000',
          effective_date: CUTOVER_DATE,
          created_by: adminId,
        },
      ]);

      const [audit] = await pool.query<RowDataPacket[]>(
        `SELECT user_id, entity_type, entity_id, after_json FROM audit_log
         WHERE action = 'liquidity.cutover_initialized'`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ user_id: adminId, entity_type: 'liquidity_cutover', entity_id: '1' });
      const after = typeof audit[0]?.after_json === 'string' ? JSON.parse(audit[0].after_json) : audit[0]?.after_json;
      expect(after).toMatchObject({ openingAmount: '1250000.5000', takeProfitHighWaterId: HUGE_TAKE_PROFIT_ID });

      // No backfill of historical sources and no settings change.
      expect(await minWorkingCapitalSnapshot()).toBe(settingsBefore);
    });

    it('uses zero high-water marks on an empty store', async () => {
      const res = await postCutover();
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        opnameHighWaterId: '0',
        stockInHighWaterId: '0',
        stockInPaymentHighWaterId: '0',
        consignorPaymentHighWaterId: '0',
        takeProfitHighWaterId: '0',
      });
    });

    it('returns 409 on retry without duplicating the row, event or audit', async () => {
      expect((await postCutover()).status).toBe(201);

      const retry = await postCutover({ ...validBody, openingAmount: '999' });
      expect(retry.status).toBe(409);
      expect(retry.body.error.code).toBe('LIQUIDITY_CUTOVER_ALREADY_INITIALIZED');

      expect(await countRows('liquidity_cutover')).toBe(1);
      expect((await cutoverRows())[0]?.opening_amount).toBe('1250000.5000');
      expect(await countRows('liquidity_events')).toBe(1);
      expect(await auditCount()).toBe(1);
    });

    it('lets exactly one of several concurrent requests succeed', async () => {
      const results = await Promise.all([postCutover(), postCutover(), postCutover()]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409]);
      expect(await countRows('liquidity_cutover')).toBe(1);
      expect(await countRows('liquidity_events')).toBe(1);
      expect(await auditCount()).toBe(1);
    });

    it('rolls back the cutover row and audit when the opening event fails', async () => {
      vi.spyOn(LiquidityRepository.prototype, 'appendEvent').mockRejectedValueOnce(
        new Error('injected liquidity_events failure'),
      );

      const res = await postCutover();
      expect(res.status).toBe(500);
      expect(await countRows('liquidity_cutover')).toBe(0);
      expect(await countRows('liquidity_events')).toBe(0);
      expect(await auditCount()).toBe(0);

      // Nothing was left behind, so a later attempt can still initialize.
      expect((await postCutover()).status).toBe(201);
      expect(await countRows('liquidity_events')).toBe(1);
    });

    it('refuses with 409 and writes nothing while a draft opname exists', async () => {
      const product = await authedPost('/api/v1/products', {
        name: 'Teh Gelas',
        ownerType: 'own',
        consignorId: null,
        pcsPerPack: 1,
        sellPrice: '1000.0000',
        marginType: null,
        marginValue: null,
      });
      expect(product.status).toBe(201);
      const draft = await authedPost('/api/v1/opnames/draft', {
        opnameDate: '2026-10-05',
        items: [{ productId: product.body.data.id, physicalQty: 0 }],
      });
      expect(draft.status).toBe(200);
      const settingsBefore = await minWorkingCapitalSnapshot();

      const res = await postCutover();
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LIQUIDITY_CUTOVER_HAS_OPEN_OPNAMES');
      expect(await countRows('liquidity_cutover')).toBe(0);
      expect(await countRows('liquidity_events')).toBe(0);
      expect(await auditCount()).toBe(0);
      expect(await countRows('opnames', `status = 'draft'`)).toBe(1);
      expect(await minWorkingCapitalSnapshot()).toBe(settingsBefore);
    });

    it('waits for an in-flight source write holding the common lock and counts it as historical', async () => {
      const conn = await pool.getConnection();
      let pending: Promise<request.Response> | undefined;
      let sourceId: string | undefined;
      try {
        await conn.beginTransaction();
        await new LiquidityRepository().lockCutoverForUpdate(conn);
        const [result] = await conn.execute(
          `INSERT INTO take_profits (amount, withdrawal_date, payment_method)
           VALUES ('5000.0000', ?, 'cash')`,
          [BEFORE_CUTOFF],
        );
        sourceId = String((result as { insertId: number }).insertId);

        pending = postCutover().then((r) => r);
        // Give the cutover request time to reach (and block on) the common lock.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await countRows('liquidity_cutover')).toBe(0);
        await conn.commit();
      } finally {
        conn.release();
      }

      const res = await pending;
      expect(res?.status).toBe(201);
      expect(res?.body.data.takeProfitHighWaterId).toBe(sourceId);
    });
  });
});
