import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAdmin } from '../../src/services/admin.service.js';
import { cleanDatabase, createTestPool, getTestEnv } from '../helpers/db.js';

const T0 = new Date('2026-10-03T09:00:00.000Z');
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

async function createConsignor(name: string): Promise<number> {
  const res = await authedPost('/api/v1/consignors', {
    name,
    phone: '08123456789',
    defaultMarginType: 'nominal',
    defaultMarginValue: '1000.0000',
  });
  return res.body.data.id;
}

async function createProduct(data: {
  name: string;
  ownerType: 'own' | 'consignor';
  consignorId?: number;
  pcsPerPack?: number;
  sellPrice: string;
  marginType?: 'nominal' | 'percent';
  marginValue?: string;
}): Promise<number> {
  const res = await authedPost('/api/v1/products', {
    name: data.name,
    ownerType: data.ownerType,
    consignorId: data.consignorId ?? null,
    pcsPerPack: data.pcsPerPack ?? 1,
    sellPrice: data.sellPrice,
    marginType: data.marginType ?? null,
    marginValue: data.marginValue ?? null,
  });
  return res.body.data.id;
}

describe('Dashboard & Cash Reconciliation API (/api/v1/dashboard)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Security & Authentication', () => {
    it('returns 401 UNAUTHENTICATED when accessing summary without session', async () => {
      const res = await request(app).get('/api/v1/dashboard/summary');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 401 UNAUTHENTICATED when accessing reconciliation without session', async () => {
      const res = await request(app)
        .post('/api/v1/dashboard/reconciliation')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ cashAmount: '10000' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('GET /api/v1/dashboard/summary', () => {
    it('returns zeroed overview and empty lists when database is freshly initialized', async () => {
      const res = await authedGet('/api/v1/dashboard/summary');
      expect(res.status).toBe(200);

      const data = res.body.data;
      expect(data.overview.activeProductsCount).toBe(0);
      expect(data.overview.activeConsignorsCount).toBe(0);
      expect(data.overview.latestOpname).toBeNull();
      expect(data.overview.totalStockValuation).toBe('0.0000');
      expect(data.overview.totalUnpaidConsignorBalance).toBe('0.0000');
      expect(data.overview.hasActiveDraft).toBe(false);
      expect(data.topProducts).toEqual([]);
      expect(data.recentOpnames).toEqual([]);
      expect(data.pendingPayoutConsignors).toEqual([]);
      expect(data.latestReconciliation).toBeNull();
    });

    it('returns comprehensive dashboard data after opname is finalized', async () => {
      // 1. Create own product & consignor product
      const geryId = await createProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
        pcsPerPack: 10,
      });

      const saniId = await createConsignor('Pak Sani');
      const lemperId = await createProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
        marginType: 'nominal',
        marginValue: '1000.0000',
      });

      // 2. Stock in
      await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-01',
        lines: [{ productId: geryId, inputMode: 'pack', qtyPack: 1, totalCost: '10000.0000' }],
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-01',
        lines: [{ productId: lemperId, qtyPcs: 10 }],
      });

      // 3. Finalize opname: Gery physical 3 (sold 7 * 1500 = 10500), Lemper physical 2 (sold 8 * 7000 = 56000)
      // Total turnover = 66500.0000
      const finalizeRes = await authedPost('/api/v1/opnames/finalize', {
        opnameDate: '2026-10-02',
        note: 'Opname Toko Awal Bulan',
        items: [
          { productId: geryId, physicalQty: 3 },
          { productId: lemperId, physicalQty: 2 },
        ],
      });
      expect(finalizeRes.status).toBe(201);

      // 4. Check dashboard summary
      const res = await authedGet('/api/v1/dashboard/summary');
      expect(res.status).toBe(200);

      const data = res.body.data;
      expect(data.overview.activeProductsCount).toBe(2);
      expect(data.overview.activeConsignorsCount).toBe(1);
      expect(data.overview.latestOpname).not.toBeNull();
      expect(data.overview.latestOpname.totalTurnover).toBe('66500.0000');
      expect(data.overview.latestOpname.totalSoldQty).toBe(15);
      expect(data.overview.totalStockValuation).toBe('3000.0000'); // 3 pcs remaining * 1000 avg cost

      // Breakdown check
      expect(data.turnoverBreakdown.ownTurnover).toBe('10500.0000');
      expect(data.turnoverBreakdown.consignorTurnover).toBe('56000.0000');
      expect(data.turnoverBreakdown.totalTurnover).toBe('66500.0000');

      // Top products (ordered by turnover desc: Lemper first, then Gery)
      expect(data.topProducts.length).toBe(2);
      expect(data.topProducts[0].name).toBe('Lemper Ayam');
      expect(data.topProducts[0].turnover).toBe('56000.0000');
      expect(data.topProducts[1].name).toBe('Gery Salut');
      expect(data.topProducts[1].turnover).toBe('10500.0000');

      // Recent opnames
      expect(data.recentOpnames.length).toBe(1);
      expect(data.recentOpnames[0].opnameDate).toBe('2026-10-02');

      // Pending payout check (Pak Sani payout due = 8 sold * 6000 = 48000)
      expect(data.pendingPayoutConsignors.length).toBe(1);
      expect(data.pendingPayoutConsignors[0].consignorName).toBe('Pak Sani');
      expect(data.pendingPayoutConsignors[0].balance).toBe('48000.0000');
      expect(data.overview.totalUnpaidConsignorBalance).toBe('48000.0000');

      // Baseline reconciliation
      expect(data.latestReconciliation).not.toBeNull();
      expect(data.latestReconciliation.theoreticalTurnover).toBe('66500.0000');
      expect(data.latestReconciliation.invariantI3Satisfied).toBe(true);
    });
  });

  describe('POST /api/v1/dashboard/reconciliation', () => {
    it('returns 404 NO_FINALIZED_OPNAME when reconciling without any final opname', async () => {
      const res = await authedPost('/api/v1/dashboard/reconciliation', {
        cashAmount: '10000.0000',
        qrisAmount: '0.0000',
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NO_FINALIZED_OPNAME');
    });

    it('calculates reconciliation and verifies Invariant I3 with exact cash', async () => {
      // 1. Setup products and opname
      const geryId = await createProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
        pcsPerPack: 10,
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-01',
        lines: [{ productId: geryId, inputMode: 'pack', qtyPack: 1, totalCost: '10000.0000' }],
      });

      const opnameRes = await authedPost('/api/v1/opnames/finalize', {
        opnameDate: '2026-10-02',
        items: [{ productId: geryId, physicalQty: 3 }],
      });
      const opnameId = opnameRes.body.data.id;

      // Turnover = 7 sold * 1500 = 10500.
      // Reconcile with exact physical cash: cash = 10500, qris = 0
      const recRes = await authedPost('/api/v1/dashboard/reconciliation', {
        opnameId,
        cashAmount: '10500.0000',
        qrisAmount: '0.0000',
      });

      expect(recRes.status).toBe(200);
      const data = recRes.body.data;
      expect(data.theoreticalTurnover).toBe('10500.0000');
      expect(data.realCash).toBe('10500.0000');
      expect(data.cashDifference).toBe('0.0000');
      expect(data.cashDifferenceHint).toContain('cocok');
      expect(data.totalCogs).toBe('7000.0000');
      expect(data.profitA).toBe('3500.0000'); // 10500 turnover - 7000 cogs
      expect(data.modalBelanjaOwn).toBe('10000.0000');
      expect(data.profitB).toBe('500.0000'); // 10500 realCash - 10000 modalBelanjaOwn
      expect(data.invariantI3Satisfied).toBe(true);
    });

    it('identifies cash shortage and maintains Invariant I3', async () => {
      const geryId = await createProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
        pcsPerPack: 10,
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-01',
        lines: [{ productId: geryId, inputMode: 'pack', qtyPack: 1, totalCost: '10000.0000' }],
      });

      await authedPost('/api/v1/opnames/finalize', {
        opnameDate: '2026-10-02',
        items: [{ productId: geryId, physicalQty: 3 }],
      });

      // Turnover is 10500, but drawer only has 8000
      const recRes = await authedPost('/api/v1/dashboard/reconciliation', {
        cashAmount: '8000.0000',
        qrisAmount: '0.0000',
      });

      expect(recRes.status).toBe(200);
      const data = recRes.body.data;
      expect(data.realCash).toBe('8000.0000');
      expect(data.cashDifference).toBe('-2500.0000');
      expect(data.cashDifferenceHint).toContain('Kekurangan');
      expect(data.invariantI3Satisfied).toBe(true);
    });
  });
});
