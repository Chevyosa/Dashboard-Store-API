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

async function createConsignor(name: string): Promise<number> {
  const res = await authedPost('/api/v1/consignors', { name, phone: '08123456789' });
  return res.body.data.id;
}

async function createProduct(data: {
  name: string;
  ownerType: 'own' | 'consignor';
  consignorId?: number | null;
  sellPrice: string;
  pcsPerPack?: number;
  marginType?: 'nominal' | 'percent' | null;
  marginValue?: string | null;
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

describe('Opname API (/api/v1/opnames)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('GET /api/v1/opnames/prepare', () => {
    it('prepares opname sheet with stock movements and previous stock', async () => {
      const geryId = await createProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
        pcsPerPack: 10,
      });

      // Stock in: 1 pack = 10 pcs, cost 10000
      await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-01',
        lines: [{ productId: geryId, inputMode: 'pack', qtyPack: 1, totalCost: '10000.0000' }],
      });

      const res = await authedGet('/api/v1/opnames/prepare?date=2026-10-02');
      expect(res.status).toBe(200);
      expect(res.body.data.opnameDate).toBe('2026-10-02');
      expect(res.body.data.products.length).toBe(1);

      const prod = res.body.data.products[0];
      expect(prod.productId).toBe(geryId);
      expect(prod.productName).toBe('Gery Salut');
      expect(prod.openingQty).toBe(0);
      expect(prod.inQty).toBe(10);
      expect(prod.expectedQty).toBe(10);
    });
  });

  describe('POST /api/v1/opnames/calculate (Golden Scenarios G1-G6, G10, G11)', () => {
    it('calculates Golden G1: Own + pack (Gery Salut)', async () => {
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

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: geryId, physicalQty: 3 }],
      });

      expect(res.status).toBe(200);
      const item = res.body.data.calculatedItems[0];
      expect(item.avgCost).toBe('1000.0000');
      expect(item.ownerMarginPerPcs).toBe('500.0000');
      expect(item.soldQty).toBe(7);
      expect(item.turnover).toBe('10500.0000');
      expect(item.cogs).toBe('7000.0000');
      expect(item.closingValue).toBe('3000.0000');
    });

    it('calculates Golden G2: Titipan nominal (Pak Sani)', async () => {
      const saniId = await createConsignor('Pak Sani');
      const lemperId = await createProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
        marginType: 'nominal',
        marginValue: '1000.0000',
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-01',
        lines: [{ productId: lemperId, qtyPcs: 10 }],
      });

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: lemperId, physicalQty: 0 }],
      });

      expect(res.status).toBe(200);
      const item = res.body.data.calculatedItems[0];
      expect(item.soldQty).toBe(10);
      expect(item.turnover).toBe('70000.0000');
      expect(item.ownerMarginPerPcs).toBe('1000.0000');
      expect(item.consignorSharePerPcs).toBe('6000.0000');
      expect(item.payoutDue).toBe('60000.0000');

      const payout = res.body.data.calculatedPayouts[0];
      expect(payout.consignorId).toBe(saniId);
      expect(payout.payoutDue).toBe('60000.0000');
    });

    it('calculates Golden G3: Titipan persen (Kak Peja)', async () => {
      const pejaId = await createConsignor('Kak Peja');
      const risolesId = await createProduct({
        name: 'Risoles',
        ownerType: 'consignor',
        consignorId: pejaId,
        sellPrice: '10000.0000',
        marginType: 'percent',
        marginValue: '3.6500',
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-01',
        lines: [{ productId: risolesId, qtyPcs: 20 }],
      });

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: risolesId, physicalQty: 0 }],
      });

      expect(res.status).toBe(200);
      const item = res.body.data.calculatedItems[0];
      expect(item.soldQty).toBe(20);
      expect(item.turnover).toBe('200000.0000');
      expect(item.ownerMarginPerPcs).toBe('365.0000');
      expect(item.consignorSharePerPcs).toBe('9635.0000');
      expect(item.soldShare).toBe('192700.0000');
      expect(item.payoutDue).toBe('192700.0000');
    });

    it('calculates Golden G4: Loss titipan ditanggung owner', async () => {
      const saniId = await createConsignor('Pak Sani');
      const lemperId = await createProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
        marginType: 'nominal',
        marginValue: '1000.0000',
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-01',
        lines: [{ productId: lemperId, qtyPcs: 10 }],
      });

      await authedPost('/api/v1/losses', {
        productId: lemperId,
        qtyPcs: 1,
        reason: 'damaged_on_display',
        borneBy: 'owner',
        date: '2026-10-01',
      });

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: lemperId, physicalQty: 2 }],
      });

      expect(res.status).toBe(200);
      const item = res.body.data.calculatedItems[0];
      expect(item.diffQty).toBe(8);
      expect(item.lossQty).toBe(1);
      expect(item.soldQty).toBe(7);
      expect(item.turnover).toBe('49000.0000');
      expect(item.soldShare).toBe('42000.0000');
      expect(item.lossCompensation).toBe('6000.0000');
      expect(item.payoutDue).toBe('48000.0000');
    });

    it('calculates Golden G5: Loss titipan ditanggung penitip', async () => {
      const saniId = await createConsignor('Pak Sani');
      const lemperId = await createProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
        marginType: 'nominal',
        marginValue: '1000.0000',
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-01',
        lines: [{ productId: lemperId, qtyPcs: 10 }],
      });

      await authedPost('/api/v1/losses', {
        productId: lemperId,
        qtyPcs: 1,
        reason: 'expired',
        borneBy: 'consignor',
        date: '2026-10-01',
      });

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: lemperId, physicalQty: 2 }],
      });

      expect(res.status).toBe(200);
      const item = res.body.data.calculatedItems[0];
      expect(item.soldQty).toBe(7);
      expect(item.turnover).toBe('49000.0000');
      expect(item.lossCompensation).toBe('0.0000');
      expect(item.payoutDue).toBe('42000.0000');
    });

    it('calculates Golden G6: Own weighted average + loss', async () => {
      const prodId = await createProduct({
        name: 'Produk Own G6',
        ownerType: 'own',
        sellPrice: '3000.0000',
      });

      // Period 1: in 4 pcs total cost 8.000 -> finalize physical 4
      await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-09-24',
        lines: [{ productId: prodId, inputMode: 'pcs', qtyPcs: 4, totalCost: '8000.0000' }],
      });

      const p1Res = await authedPost('/api/v1/opnames/finalize', {
        opnameDate: '2026-09-25',
        items: [{ productId: prodId, physicalQty: 4 }],
      });
      expect(p1Res.status).toBe(201);

      // Period 2: in 6 pcs total cost 15.000, loss 1 pcs 'lost', physical 3
      await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-01',
        lines: [{ productId: prodId, inputMode: 'pcs', qtyPcs: 6, totalCost: '15000.0000' }],
      });

      await authedPost('/api/v1/losses', {
        productId: prodId,
        qtyPcs: 1,
        reason: 'lost',
        borneBy: 'owner',
        date: '2026-10-01',
      });

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: prodId, physicalQty: 3 }],
      });

      expect(res.status).toBe(200);
      const item = res.body.data.calculatedItems[0];
      expect(item.openingQty).toBe(4);
      expect(item.openingValue).toBe('8000.0000');
      expect(item.inQty).toBe(6);
      expect(item.inCost).toBe('15000.0000');
      expect(item.avgCost).toBe('2300.0000');
      expect(item.soldQty).toBe(6);
      expect(item.turnover).toBe('18000.0000');
      expect(item.cogs).toBe('13800.0000');
      expect(item.ownLossCost).toBe('2300.0000');
      expect(item.closingValue).toBe('6900.0000');
    });

    it('calculates Golden G10: Persen + loss ditanggung owner', async () => {
      const pejaId = await createConsignor('Kak Peja');
      const risolesId = await createProduct({
        name: 'Risoles',
        ownerType: 'consignor',
        consignorId: pejaId,
        sellPrice: '10000.0000',
        marginType: 'percent',
        marginValue: '3.6500',
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-01',
        lines: [{ productId: risolesId, qtyPcs: 20 }],
      });

      await authedPost('/api/v1/losses', {
        productId: risolesId,
        qtyPcs: 1,
        reason: 'damaged_on_display',
        borneBy: 'owner',
        date: '2026-10-01',
      });

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: risolesId, physicalQty: 5 }],
      });

      expect(res.status).toBe(200);
      const item = res.body.data.calculatedItems[0];
      expect(item.diffQty).toBe(15);
      expect(item.soldQty).toBe(14);
      expect(item.turnover).toBe('140000.0000');
      expect(item.ownerMarginPerPcs).toBe('365.0000');
      expect(item.consignorSharePerPcs).toBe('9635.0000');
      expect(item.soldShare).toBe('134890.0000');
      expect(item.lossCompensation).toBe('9635.0000');
      expect(item.payoutDue).toBe('144525.0000');
    });

    it('calculates Golden G11: Tanpa pembulatan', async () => {
      const consignorId = await createConsignor('Mitra Presisi');
      const prodId = await createProduct({
        name: 'Barang Presisi',
        ownerType: 'consignor',
        consignorId,
        sellPrice: '7777.0000',
        marginType: 'percent',
        marginValue: '3.6500',
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-01',
        lines: [{ productId: prodId, qtyPcs: 5 }],
      });

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: prodId, physicalQty: 2 }], // sold = 3
      });

      expect(res.status).toBe(200);
      const item = res.body.data.calculatedItems[0];
      expect(item.soldQty).toBe(3);
      expect(item.ownerMarginPerPcs).toBe('283.8605');
      expect(item.consignorSharePerPcs).toBe('7493.1395');
      expect(item.payoutDue).toBe('22479.4185');
    });

    it('rejects physical stock > expected with NEGATIVE_DIFF_STOCK', async () => {
      const geryId = await createProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-01',
        lines: [{ productId: geryId, qtyPcs: 5, totalCost: '5000.0000' }],
      });

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: geryId, physicalQty: 8 }], // expected 5, physical 8 -> diff -3
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NEGATIVE_DIFF_STOCK');
      expect(res.body.error.message).toContain('lebih banyak dari stok teoritis');
    });

    it('rejects loss > diff with LOSS_EXCEEDS_DIFF_STOCK', async () => {
      const geryId = await createProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
      });

      await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-01',
        lines: [{ productId: geryId, qtyPcs: 5, totalCost: '5000.0000' }],
      });

      await authedPost('/api/v1/losses', {
        productId: geryId,
        qtyPcs: 3,
        reason: 'lost',
        borneBy: 'owner',
        date: '2026-10-01',
      });

      const res = await authedPost('/api/v1/opnames/calculate', {
        opnameDate: '2026-10-02',
        items: [{ productId: geryId, physicalQty: 4 }], // expected 5, diff 1, loss 3 -> sold -2
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LOSS_EXCEEDS_DIFF_STOCK');
      expect(res.body.error.message).toContain('melebihi selisih stok');
    });
  });

  describe('Draft & Finalize lifecycle', () => {
    it('saves draft, updates draft, and deletes draft', async () => {
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

      const draftRes = await authedPost('/api/v1/opnames/draft', {
        opnameDate: '2026-10-02',
        note: 'Draf sementara Jumat pagi',
        items: [{ productId: geryId, physicalQty: 4 }],
      });

      expect(draftRes.status).toBe(200);
      expect(draftRes.body.data.status).toBe('draft');
      expect(draftRes.body.data.note).toBe('Draf sementara Jumat pagi');
      const opnameId = draftRes.body.data.id;

      // Check prepare includes draft count
      const prepRes = await authedGet('/api/v1/opnames/prepare?date=2026-10-02');
      expect(prepRes.body.data.products[0].draftPhysicalQty).toBe(4);

      // Delete draft
      const delRes = await authedDelete(`/api/v1/opnames/${opnameId}/draft`);
      expect(delRes.status).toBe(200);

      const getRes = await authedGet(`/api/v1/opnames/${opnameId}`);
      expect(getRes.status).toBe(404);
    });

    it('finalizes opname, attaches movements, freezes snapshots, and cascades to next period', async () => {
      const geryId = await createProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
        pcsPerPack: 10,
      });

      const stockInRes = await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-01',
        lines: [{ productId: geryId, inputMode: 'pack', qtyPack: 1, totalCost: '10000.0000' }],
      });
      const stockInId = stockInRes.body.data.id;

      const finalRes = await authedPost('/api/v1/opnames/finalize', {
        opnameDate: '2026-10-02',
        note: 'Opname Jumat 2 Okt',
        items: [{ productId: geryId, physicalQty: 3 }],
      });

      expect(finalRes.status).toBe(201);
      expect(finalRes.body.data.status).toBe('final');
      const opnameId = finalRes.body.data.id;

      // Verify movements attached
      const [siRows] = await pool.query<RowDataPacket[]>(
        'SELECT opname_id FROM stock_ins WHERE id = ?',
        [stockInId],
      );
      expect(siRows[0]?.opname_id).toBe(opnameId);

      // Verify audit log
      const [auditRows] = await pool.query<RowDataPacket[]>(
        'SELECT action FROM audit_log WHERE entity_type = "opname" AND entity_id = ?',
        [String(opnameId)],
      );
      expect(auditRows.some((r) => r.action === 'opname.finalized')).toBe(true);

      // Verify next opname prepare receives opening stock
      const prepRes = await authedGet('/api/v1/opnames/prepare?date=2026-10-09');
      const prod2 = prepRes.body.data.products[0];
      expect(prod2.openingQty).toBe(3);
      expect(prod2.openingValue).toBe('3000.0000');

      // Verify cannot delete final opname
      const delRes = await authedDelete(`/api/v1/opnames/${opnameId}/draft`);
      expect(delRes.status).toBe(409);
      expect(delRes.body.error.code).toBe('CANNOT_DELETE_FINAL_OPNAME');

      // Verify cannot finalize again on same date
      const repeatRes = await authedPost('/api/v1/opnames/finalize', {
        opnameDate: '2026-10-02',
        items: [{ productId: geryId, physicalQty: 3 }],
      });
      expect(repeatRes.status).toBe(409);
      expect(repeatRes.body.error.code).toBe('PERIOD_ALREADY_FINALIZED');
    });

    it('records weekly cash intake, persists reconciliation figures in DB, and serves them in detail and list', async () => {
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

      // Draft with cashAmount 7000 and qrisAmount 3000
      // 10 in stock, 3 physical -> 7 sold @ 1500 = 10500 turnover
      // real cash = 10000, difference = 10000 - 10500 = -500
      const draftRes = await authedPost('/api/v1/opnames/draft', {
        opnameDate: '2026-10-02',
        note: 'Draf kas mingguan',
        items: [{ productId: geryId, physicalQty: 3 }],
        cashAmount: '7000.0000',
        qrisAmount: '3000.0000',
      });

      expect(draftRes.status).toBe(200);
      expect(draftRes.body.data.cashAmount).toBe('7000.0000');
      expect(draftRes.body.data.qrisAmount).toBe('3000.0000');
      expect(draftRes.body.data.realCash).toBe('10000.0000');
      expect(draftRes.body.data.cashDifference).toBe('-500.0000');
      expect(draftRes.body.data.profitA).toBe('3500.0000');
      expect(draftRes.body.data.profitB).toBe('0.0000');

      // Finalize with cash intake (exact match)
      const finalRes = await authedPost('/api/v1/opnames/finalize', {
        opnameDate: '2026-10-02',
        note: 'Finalisasi kas mingguan',
        items: [{ productId: geryId, physicalQty: 3 }],
        cashAmount: '8000.0000',
        qrisAmount: '2500.0000',
      });

      expect(finalRes.status).toBe(201);
      const opnameId = finalRes.body.data.id;
      expect(finalRes.body.data.cashAmount).toBe('8000.0000');
      expect(finalRes.body.data.qrisAmount).toBe('2500.0000');
      expect(finalRes.body.data.realCash).toBe('10500.0000');
      expect(finalRes.body.data.cashDifference).toBe('0.0000');
      expect(finalRes.body.data.profitA).toBe('3500.0000');
      expect(finalRes.body.data.profitB).toBe('500.0000');

      // Verify DB persistence directly
      const [dbRows] = await pool.query<RowDataPacket[]>(
        'SELECT cash_amount, qris_amount, real_cash, cash_difference, profit_a, profit_b FROM opnames WHERE id = ?',
        [opnameId],
      );
      expect(String(dbRows[0]?.cash_amount)).toBe('8000.0000');
      expect(String(dbRows[0]?.qris_amount)).toBe('2500.0000');
      expect(String(dbRows[0]?.real_cash)).toBe('10500.0000');
      expect(String(dbRows[0]?.cash_difference)).toBe('0.0000');
      expect(String(dbRows[0]?.profit_a)).toBe('3500.0000');
      expect(String(dbRows[0]?.profit_b)).toBe('500.0000');

      // Verify GET /api/v1/opnames/:id returns the cash reconciliation
      const getRes = await authedGet(`/api/v1/opnames/${opnameId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.realCash).toBe('10500.0000');
      expect(getRes.body.data.cashDifference).toBe('0.0000');

      // Verify GET /api/v1/opnames (list) returns the cash reconciliation
      const listRes = await authedGet('/api/v1/opnames');
      expect(listRes.status).toBe(200);
      const found = listRes.body.data.find((o: { id: number }) => o.id === opnameId);
      expect(found).toBeDefined();
      expect(found.realCash).toBe('10500.0000');
    });
  });
});
