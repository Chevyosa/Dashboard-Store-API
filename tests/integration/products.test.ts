import type { Express } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
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

const authedPatch = (url: string, body?: unknown) =>
  request(app)
    .patch(url)
    .set('Cookie', `store_sid=${sessionCookie}`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .send(body as object);

async function createConsignor(name: string, isActive = true): Promise<number> {
  const res = await authedPost('/api/v1/consignors', {
    name,
    phone: '08123456789',
  });
  const id = res.body.data.id;
  if (!isActive) {
    await authedPatch(`/api/v1/consignors/${id}/status`, { isActive: false });
  }
  return id;
}

describe('Products API (/api/v1/products)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Auth guards & CSRF', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/v1/products');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects POST requests missing CSRF header with 403', async () => {
      const res = await request(app)
        .post('/api/v1/products')
        .set('Cookie', `store_sid=${sessionCookie}`)
        .send({ name: 'Chiki', ownerType: 'own', sellPrice: '5000' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    });
  });

  describe('Preview Margin (POST /api/v1/products/preview)', () => {
    it('calculates Golden G2: Titipan nominal (Pak Sani 7000, margin 1000)', async () => {
      const res = await authedPost('/api/v1/products/preview', {
        ownerType: 'consignor',
        pcsPerPack: 1,
        sellPrice: '7000',
        marginType: 'nominal',
        marginValue: '1000',
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        ownerMarginPerPcs: '1000.0000',
        ownerMarginPerPack: '1000.0000',
        consignorSharePerPcs: '6000.0000',
        consignorSharePerPack: '6000.0000',
      });
    });

    it('calculates Golden G3: Titipan persen (Kak Peja 10000, 3.65%)', async () => {
      const res = await authedPost('/api/v1/products/preview', {
        ownerType: 'consignor',
        pcsPerPack: 1,
        sellPrice: '10000',
        marginType: 'percent',
        marginValue: '3.65',
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        ownerMarginPerPcs: '365.0000',
        ownerMarginPerPack: '365.0000',
        consignorSharePerPcs: '9635.0000',
        consignorSharePerPack: '9635.0000',
      });
    });

    it('calculates Golden G11: Tanpa pembulatan (7777, 3.65%)', async () => {
      const res = await authedPost('/api/v1/products/preview', {
        ownerType: 'consignor',
        pcsPerPack: 1,
        sellPrice: '7777',
        marginType: 'percent',
        marginValue: '3.65',
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        ownerMarginPerPcs: '283.8605',
        ownerMarginPerPack: '283.8605',
        consignorSharePerPcs: '7493.1395',
        consignorSharePerPack: '7493.1395',
      });
    });

    it('calculates Golden G1: Own product with avgCost and pack (Gery Salut)', async () => {
      const res = await authedPost('/api/v1/products/preview', {
        ownerType: 'own',
        pcsPerPack: 10,
        sellPrice: '1500',
        avgCost: '1000',
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        ownerMarginPerPcs: '500.0000',
        ownerMarginPerPack: '5000.0000',
        consignorSharePerPcs: null,
        consignorSharePerPack: null,
      });
    });

    it('returns null margin when own product does not have avgCost', async () => {
      const res = await authedPost('/api/v1/products/preview', {
        ownerType: 'own',
        pcsPerPack: 1,
        sellPrice: '2000',
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        ownerMarginPerPcs: null,
        ownerMarginPerPack: null,
        consignorSharePerPcs: null,
        consignorSharePerPack: null,
      });
    });

    it('rejects nominal margin greater than or equal to sellPrice', async () => {
      const res = await authedPost('/api/v1/products/preview', {
        ownerType: 'consignor',
        sellPrice: '5000',
        marginType: 'nominal',
        marginValue: '5000',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects percent margin out of bounds (<= 0 or >= 100)', async () => {
      const res1 = await authedPost('/api/v1/products/preview', {
        ownerType: 'consignor',
        sellPrice: '5000',
        marginType: 'percent',
        marginValue: '0',
      });
      expect(res1.status).toBe(400);

      const res2 = await authedPost('/api/v1/products/preview', {
        ownerType: 'consignor',
        sellPrice: '5000',
        marginType: 'percent',
        marginValue: '100',
      });
      expect(res2.status).toBe(400);
    });
  });

  describe('Create Product (POST /api/v1/products)', () => {
    it('creates own product (Golden G1: Gery Salut)', async () => {
      const res = await authedPost('/api/v1/products', {
        name: 'Gery Salut Malkist',
        ownerType: 'own',
        pcsPerPack: 10,
        sellPrice: '1500',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Gery Salut Malkist');
      expect(res.body.data.ownerType).toBe('own');
      expect(res.body.data.consignorId).toBeNull();
      expect(res.body.data.consignorName).toBeNull();
      expect(res.body.data.pcsPerPack).toBe(10);
      expect(res.body.data.sellPrice).toBe('1500.0000');
      expect(res.body.data.marginType).toBeNull();
      expect(res.body.data.marginValue).toBeNull();
      expect(res.body.data.isActive).toBe(true);
      expect(res.body.data.marginInfo.ownerMarginPerPcs).toBeNull();
    });

    it('creates consignor nominal product (Golden G2: Pak Sani)', async () => {
      const consignorId = await createConsignor('Pak Sani');

      const res = await authedPost('/api/v1/products', {
        name: 'Risoles Mayo',
        ownerType: 'consignor',
        consignorId,
        pcsPerPack: 1,
        sellPrice: '7000',
        marginType: 'nominal',
        marginValue: '1000',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Risoles Mayo');
      expect(res.body.data.ownerType).toBe('consignor');
      expect(res.body.data.consignorId).toBe(consignorId);
      expect(res.body.data.consignorName).toBe('Pak Sani');
      expect(res.body.data.sellPrice).toBe('7000.0000');
      expect(res.body.data.marginType).toBe('nominal');
      expect(res.body.data.marginValue).toBe('1000.0000');
      expect(res.body.data.marginInfo).toEqual({
        ownerMarginPerPcs: '1000.0000',
        ownerMarginPerPack: '1000.0000',
        consignorSharePerPcs: '6000.0000',
        consignorSharePerPack: '6000.0000',
      });
    });

    it('creates consignor percent product (Golden G3: Kak Peja)', async () => {
      const consignorId = await createConsignor('Kak Peja');

      const res = await authedPost('/api/v1/products', {
        name: 'Donat Coklat',
        ownerType: 'consignor',
        consignorId,
        pcsPerPack: 1,
        sellPrice: '10000',
        marginType: 'percent',
        marginValue: '3.65',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.marginInfo).toEqual({
        ownerMarginPerPcs: '365.0000',
        ownerMarginPerPack: '365.0000',
        consignorSharePerPcs: '9635.0000',
        consignorSharePerPack: '9635.0000',
      });
    });

    it('rejects duplicate product name case-insensitive (409)', async () => {
      await authedPost('/api/v1/products', {
        name: 'Teh Botol Sosro',
        ownerType: 'own',
        sellPrice: '4000',
      });

      const res = await authedPost('/api/v1/products', {
        name: 'TEH BOTOL SOSRO',
        ownerType: 'own',
        sellPrice: '4500',
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_NAME_EXISTS');
    });

    it('rejects own product when consignorId or margin fields are supplied', async () => {
      const res = await authedPost('/api/v1/products', {
        name: 'Kopi Kenangan',
        ownerType: 'own',
        consignorId: 1,
        sellPrice: '10000',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects consignor product without consignorId', async () => {
      const res = await authedPost('/api/v1/products', {
        name: 'Keripik Tempe',
        ownerType: 'consignor',
        sellPrice: '10000',
        marginType: 'nominal',
        marginValue: '1000',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects consignor product when consignor does not exist (404)', async () => {
      const res = await authedPost('/api/v1/products', {
        name: 'Keripik Singkong',
        ownerType: 'consignor',
        consignorId: 999999,
        sellPrice: '10000',
        marginType: 'nominal',
        marginValue: '1000',
      });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CONSIGNOR_NOT_FOUND');
    });

    it('rejects consignor product when consignor is inactive (409)', async () => {
      const consignorId = await createConsignor('Pak Budi', false);

      const res = await authedPost('/api/v1/products', {
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId,
        sellPrice: '5000',
        marginType: 'nominal',
        marginValue: '500',
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONSIGNOR_INACTIVE');
    });
  });

  describe('List & Filter Products (GET /api/v1/products)', () => {
    it('lists products and supports filtering by ownerType and search', async () => {
      const consignorId = await createConsignor('Pak Sani');

      await authedPost('/api/v1/products', {
        name: 'Gery Salut Malkist',
        ownerType: 'own',
        pcsPerPack: 10,
        sellPrice: '1500',
      });

      await authedPost('/api/v1/products', {
        name: 'Risoles Mayo',
        ownerType: 'consignor',
        consignorId,
        sellPrice: '7000',
        marginType: 'nominal',
        marginValue: '1000',
      });

      // All
      const resAll = await authedGet('/api/v1/products');
      expect(resAll.status).toBe(200);
      expect(resAll.body.data).toHaveLength(2);
      expect(resAll.body.pagination.total).toBe(2);

      // Filter own
      const resOwn = await authedGet('/api/v1/products?ownerType=own');
      expect(resOwn.status).toBe(200);
      expect(resOwn.body.data).toHaveLength(1);
      expect(resOwn.body.data[0].name).toBe('Gery Salut Malkist');

      // Filter consignor
      const resConsignor = await authedGet('/api/v1/products?ownerType=consignor');
      expect(resConsignor.status).toBe(200);
      expect(resConsignor.body.data).toHaveLength(1);
      expect(resConsignor.body.data[0].name).toBe('Risoles Mayo');

      // Search by consignor name
      const resSearch = await authedGet('/api/v1/products?search=Sani');
      expect(resSearch.status).toBe(200);
      expect(resSearch.body.data).toHaveLength(1);
      expect(resSearch.body.data[0].name).toBe('Risoles Mayo');
    });
  });

  describe('Get by ID (GET /api/v1/products/:id)', () => {
    it('returns product details with margin calculation', async () => {
      const consignorId = await createConsignor('Pak Sani');
      const createRes = await authedPost('/api/v1/products', {
        name: 'Pastel Telur',
        ownerType: 'consignor',
        consignorId,
        sellPrice: '6000',
        marginType: 'nominal',
        marginValue: '1000',
      });

      const id = createRes.body.data.id;
      const res = await authedGet(`/api/v1/products/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Pastel Telur');
      expect(res.body.data.consignorName).toBe('Pak Sani');
      expect(res.body.data.marginInfo.ownerMarginPerPcs).toBe('1000.0000');
    });

    it('returns 404 for non-existent product', async () => {
      const res = await authedGet('/api/v1/products/999999');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  describe('Update Product (PUT /api/v1/products/:id)', () => {
    it('updates product and recalculates margin', async () => {
      const consignorId = await createConsignor('Pak Sani');
      const createRes = await authedPost('/api/v1/products', {
        name: 'Kue Sus',
        ownerType: 'consignor',
        consignorId,
        sellPrice: '6000',
        marginType: 'nominal',
        marginValue: '1000',
      });

      const id = createRes.body.data.id;
      const updateRes = await authedPut(`/api/v1/products/${id}`, {
        name: 'Kue Sus Vanilla',
        ownerType: 'consignor',
        consignorId,
        pcsPerPack: 1,
        sellPrice: '8000',
        marginType: 'nominal',
        marginValue: '1500',
      });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.name).toBe('Kue Sus Vanilla');
      expect(updateRes.body.data.sellPrice).toBe('8000.0000');
      expect(updateRes.body.data.marginInfo.consignorSharePerPcs).toBe('6500.0000');
    });
  });

  describe('Status toggle / soft delete (PATCH /api/v1/products/:id/status)', () => {
    it('deactivates and reactivates product without deleting data', async () => {
      const createRes = await authedPost('/api/v1/products', {
        name: 'Susu UHT Coklat',
        ownerType: 'own',
        sellPrice: '6000',
      });
      const id = createRes.body.data.id;

      // Deactivate
      const deactRes = await authedPatch(`/api/v1/products/${id}/status`, { isActive: false });
      expect(deactRes.status).toBe(200);
      expect(deactRes.body.data.isActive).toBe(false);

      // Verify DB row still exists
      const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM products WHERE id = ?', [id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.is_active).toBe(0);

      // Reactivate
      const reactRes = await authedPatch(`/api/v1/products/${id}/status`, { isActive: true });
      expect(reactRes.status).toBe(200);
      expect(reactRes.body.data.isActive).toBe(true);
    });
  });

  describe('Audit Log Integration', () => {
    it('logs audit entries for created, updated, and status_changed', async () => {
      const createRes = await authedPost('/api/v1/products', {
        name: 'Tahu Bakso',
        ownerType: 'own',
        sellPrice: '3000',
      });
      const id = createRes.body.data.id;

      await authedPut(`/api/v1/products/${id}`, {
        name: 'Tahu Bakso Goreng',
        ownerType: 'own',
        sellPrice: '3500',
      });

      await authedPatch(`/api/v1/products/${id}/status`, { isActive: false });

      const [auditRows] = await pool.query<RowDataPacket[]>(
        'SELECT action, entity_type, entity_id FROM audit_log WHERE entity_type = "product" ORDER BY id ASC',
      );

      expect(auditRows).toHaveLength(3);
      expect(auditRows[0]).toMatchObject({
        action: 'product.created',
        entity_type: 'product',
        entity_id: String(id),
      });
      expect(auditRows[1]).toMatchObject({
        action: 'product.updated',
        entity_type: 'product',
        entity_id: String(id),
      });
      expect(auditRows[2]).toMatchObject({
        action: 'product.status_changed',
        entity_type: 'product',
        entity_id: String(id),
      });
    });
  });
});
