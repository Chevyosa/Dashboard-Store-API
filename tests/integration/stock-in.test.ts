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

async function createTestConsignor(name: string): Promise<number> {
  const res = await authedPost('/api/v1/consignors', { name, phone: '08123456789' });
  return res.body.data.id;
}

async function createTestProduct(data: {
  name: string;
  ownerType: 'own' | 'consignor';
  consignorId?: number | null;
  pcsPerPack?: number;
  sellPrice: string;
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

describe('Stock In API (/api/v1/stock-ins)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('POST /api/v1/stock-ins (Creation & Business Rules §5.3)', () => {
    it('creates own purchase with pack input (Golden G1: Gery Salut 1 pack isi 10 @ 10.000)', async () => {
      const geryId = await createTestProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        pcsPerPack: 10,
        sellPrice: '1500.0000',
      });

      const res = await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-04',
        note: 'Beli di agen',
        lines: [
          {
            productId: geryId,
            inputMode: 'pack',
            qtyPack: 1,
            totalCost: '10000.0000',
          },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.type).toBe('purchase');
      expect(res.body.data.date).toBe('2026-10-04');
      expect(res.body.data.totalCost).toBe('10000.0000');
      expect(res.body.data.totalQtyPcs).toBe(10);
      expect(res.body.data.linesCount).toBe(1);

      const line = res.body.data.lines[0];
      expect(line.productId).toBe(geryId);
      expect(line.productName).toBe('Gery Salut');
      expect(line.ownerType).toBe('own');
      expect(line.inputMode).toBe('pack');
      expect(line.qtyPack).toBe(1);
      expect(line.pcsPerPackSnapshot).toBe(10);
      expect(line.qtyPcs).toBe(10);
      expect(line.totalCost).toBe('10000.0000');
    });

    it('creates own purchase with pcs input (Golden G6: 6 pcs @ 15.000)', async () => {
      const tehId = await createTestProduct({
        name: 'Teh Botol',
        ownerType: 'own',
        pcsPerPack: 1,
        sellPrice: '3000.0000',
      });

      const res = await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-04',
        lines: [
          {
            productId: tehId,
            inputMode: 'pcs',
            qtyPcs: 6,
            totalCost: '15000.0000',
          },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.totalCost).toBe('15000.0000');
      expect(res.body.data.totalQtyPcs).toBe(6);
      expect(res.body.data.lines[0].qtyPack).toBeNull();
      expect(res.body.data.lines[0].qtyPcs).toBe(6);
    });

    it('forces totalCost to 0 for consignment_in (Golden G2: Pak Sani in 10 pcs)', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
        marginType: 'nominal',
        marginValue: '1000.0000',
      });

      // Even if client attempts to send totalCost > 0, system enforces 0 for titipan
      const res = await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-04',
        note: 'Setoran Pak Sani pagi',
        lines: [
          {
            productId: lemperId,
            inputMode: 'pcs',
            qtyPcs: 10,
            totalCost: '60000.0000',
          },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.type).toBe('consignment_in');
      expect(res.body.data.totalCost).toBe('0.0000');
      expect(res.body.data.totalQtyPcs).toBe(10);
      expect(res.body.data.lines[0].totalCost).toBe('0.0000');
      expect(res.body.data.lines[0].consignorName).toBe('Pak Sani');
    });

    it('rejects purchase containing consignor products', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
        marginType: 'nominal',
        marginValue: '1000.0000',
      });

      const res = await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-04',
        lines: [
          {
            productId: lemperId,
            inputMode: 'pcs',
            qtyPcs: 5,
            totalCost: '30000.0000',
          },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PRODUCT_TYPE');
      expect(res.body.error.message).toContain('titipan');
    });

    it('rejects consignment_in containing own products', async () => {
      const tehId = await createTestProduct({
        name: 'Teh Botol',
        ownerType: 'own',
        sellPrice: '3000.0000',
      });

      const res = await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-04',
        lines: [
          {
            productId: tehId,
            inputMode: 'pcs',
            qtyPcs: 5,
          },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PRODUCT_TYPE');
      expect(res.body.error.message).toContain('sendiri');
    });

    it('allows initial stock with both own and consignor items', async () => {
      const ownId = await createTestProduct({
        name: 'Kopi Kapal Api',
        ownerType: 'own',
        sellPrice: '2000.0000',
      });
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
        marginType: 'nominal',
        marginValue: '1000.0000',
      });

      const res = await authedPost('/api/v1/stock-ins', {
        type: 'initial',
        date: '2026-10-01',
        note: 'Stok awal sistem',
        lines: [
          { productId: ownId, inputMode: 'pcs', qtyPcs: 20, totalCost: '30000.0000' },
          { productId: lemperId, inputMode: 'pcs', qtyPcs: 10, totalCost: '0.0000' },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.type).toBe('initial');
      expect(res.body.data.totalCost).toBe('30000.0000');
      expect(res.body.data.totalQtyPcs).toBe(30);
      expect(res.body.data.linesCount).toBe(2);
    });
  });

  describe('GET /api/v1/stock-ins/summary/open-period', () => {
    it('summarizes purchase costs and incoming pcs for open period', async () => {
      const ownId = await createTestProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        pcsPerPack: 10,
        sellPrice: '1500.0000',
      });
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
        marginType: 'nominal',
        marginValue: '1000.0000',
      });

      // 1. Purchase own 2 pack = 20 pcs @ 20.000
      await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-02',
        lines: [{ productId: ownId, inputMode: 'pack', qtyPack: 2, totalCost: '20000.0000' }],
      });

      // 2. Consignment in 15 pcs @ 0
      await authedPost('/api/v1/stock-ins', {
        type: 'consignment_in',
        date: '2026-10-03',
        lines: [{ productId: lemperId, inputMode: 'pcs', qtyPcs: 15 }],
      });

      const res = await authedGet('/api/v1/stock-ins/summary/open-period');
      expect(res.status).toBe(200);
      expect(res.body.data.totalPurchaseCost).toBe('20000.0000');
      expect(res.body.data.totalOwnPcs).toBe(20);
      expect(res.body.data.totalConsignorPcs).toBe(15);
      expect(res.body.data.totalTransactions).toBe(2);
    });
  });

  describe('PUT & DELETE /api/v1/stock-ins/:id (Edit & Locking §5.9)', () => {
    it('updates stock in during open period and records audit', async () => {
      const ownId = await createTestProduct({
        name: 'Chitato',
        ownerType: 'own',
        sellPrice: '5000.0000',
      });

      const createRes = await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-04',
        lines: [{ productId: ownId, inputMode: 'pcs', qtyPcs: 10, totalCost: '40000.0000' }],
      });
      const stockInId = createRes.body.data.id;

      const updateRes = await authedPut(`/api/v1/stock-ins/${stockInId}`, {
        note: 'Koreksi jumlah',
        lines: [{ productId: ownId, inputMode: 'pcs', qtyPcs: 12, totalCost: '48000.0000' }],
      });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.totalCost).toBe('48000.0000');
      expect(updateRes.body.data.totalQtyPcs).toBe(12);

      // Check audit log
      const [logs] = await pool.query<RowDataPacket[]>(
        'SELECT action, entity_id FROM audit_log WHERE entity_type = "stock_in" ORDER BY id ASC',
      );
      expect(logs.length).toBe(2);
      expect(logs[0]?.action).toBe('stock_in.created');
      expect(logs[1]?.action).toBe('stock_in.updated');
    });

    it('rejects update if opname_id is set (period closed)', async () => {
      const ownId = await createTestProduct({
        name: 'Chitato',
        ownerType: 'own',
        sellPrice: '5000.0000',
      });

      const createRes = await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-04',
        lines: [{ productId: ownId, inputMode: 'pcs', qtyPcs: 10, totalCost: '40000.0000' }],
      });
      const stockInId = createRes.body.data.id;

      // Simulate period closed
      await pool.execute('UPDATE stock_ins SET opname_id = 99 WHERE id = ?', [stockInId]);

      const updateRes = await authedPut(`/api/v1/stock-ins/${stockInId}`, {
        note: 'Coba ubah periode final',
      });

      expect(updateRes.status).toBe(409);
      expect(updateRes.body.error.code).toBe('PERIOD_CLOSED');
    });

    it('deletes stock in during open period and rejects when period closed', async () => {
      const ownId = await createTestProduct({
        name: 'Chitato',
        ownerType: 'own',
        sellPrice: '5000.0000',
      });

      const createRes = await authedPost('/api/v1/stock-ins', {
        type: 'purchase',
        date: '2026-10-04',
        lines: [{ productId: ownId, inputMode: 'pcs', qtyPcs: 5, totalCost: '20000.0000' }],
      });
      const stockInId = createRes.body.data.id;

      // Simulate period closed
      await pool.execute('UPDATE stock_ins SET opname_id = 99 WHERE id = ?', [stockInId]);
      const delClosed = await authedDelete(`/api/v1/stock-ins/${stockInId}`);
      expect(delClosed.status).toBe(409);
      expect(delClosed.body.error.code).toBe('PERIOD_CLOSED');

      // Reopen and delete
      await pool.execute('UPDATE stock_ins SET opname_id = NULL WHERE id = ?', [stockInId]);
      const delOpen = await authedDelete(`/api/v1/stock-ins/${stockInId}`);
      expect(delOpen.status).toBe(200);

      const check = await authedGet(`/api/v1/stock-ins/${stockInId}`);
      expect(check.status).toBe(404);
    });
  });
});
