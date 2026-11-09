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
  sellPrice: string;
}): Promise<number> {
  const res = await authedPost('/api/v1/products', {
    name: data.name,
    ownerType: data.ownerType,
    consignorId: data.consignorId ?? null,
    pcsPerPack: 1,
    sellPrice: data.sellPrice,
    marginType: data.ownerType === 'consignor' ? 'nominal' : null,
    marginValue: data.ownerType === 'consignor' ? '1000.0000' : null,
  });
  return res.body.data.id;
}

describe('Stock Returns API (/api/v1/stock-returns)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('POST /api/v1/stock-returns (Rules §5.7)', () => {
    it('creates return record for consignor products', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
      });

      const res = await authedPost('/api/v1/stock-returns', {
        productId: lemperId,
        qtyPcs: 3,
        date: '2026-10-04',
        note: 'Sisa ditarik penitip',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.productId).toBe(lemperId);
      expect(res.body.data.productName).toBe('Lemper Ayam');
      expect(res.body.data.consignorName).toBe('Pak Sani');
      expect(res.body.data.qtyPcs).toBe(3);
      expect(res.body.data.date).toBe('2026-10-04');
      expect(res.body.data.opnameId).toBeNull();
    });

    it('rejects return for own products', async () => {
      const ownId = await createTestProduct({
        name: 'Teh Botol',
        ownerType: 'own',
        sellPrice: '3000.0000',
      });

      const res = await authedPost('/api/v1/stock-returns', {
        productId: ownId,
        qtyPcs: 2,
        date: '2026-10-04',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PRODUCT_TYPE');
      expect(res.body.error.message).toContain('titipan');
    });

    it('rejects return with invalid quantity', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
      });

      const res = await authedPost('/api/v1/stock-returns', {
        productId: lemperId,
        qtyPcs: 0,
        date: '2026-10-04',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PUT & DELETE /api/v1/stock-returns/:id', () => {
    it('updates open return and records audit log', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
      });

      const createRes = await authedPost('/api/v1/stock-returns', {
        productId: lemperId,
        qtyPcs: 3,
        date: '2026-10-04',
      });
      const returnId = createRes.body.data.id;

      const updateRes = await authedPut(`/api/v1/stock-returns/${returnId}`, {
        qtyPcs: 5,
        note: 'Koreksi hitungan fisik retur',
      });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.qtyPcs).toBe(5);
      expect(updateRes.body.data.note).toBe('Koreksi hitungan fisik retur');

      const [logs] = await pool.query<RowDataPacket[]>(
        'SELECT action FROM audit_log WHERE entity_type = "stock_return" ORDER BY id ASC',
      );
      expect(logs.length).toBe(2);
      expect(logs[0]?.action).toBe('stock_return.created');
      expect(logs[1]?.action).toBe('stock_return.updated');
    });

    it('rejects update and delete when period closed (opname_id != null)', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
      });

      const createRes = await authedPost('/api/v1/stock-returns', {
        productId: lemperId,
        qtyPcs: 3,
        date: '2026-10-04',
      });
      const returnId = createRes.body.data.id;

      // Lock return to finalized opname
      await pool.execute('UPDATE stock_returns SET opname_id = 101 WHERE id = ?', [returnId]);

      const putRes = await authedPut(`/api/v1/stock-returns/${returnId}`, { qtyPcs: 4 });
      expect(putRes.status).toBe(409);
      expect(putRes.body.error.code).toBe('PERIOD_CLOSED');

      const delRes = await authedDelete(`/api/v1/stock-returns/${returnId}`);
      expect(delRes.status).toBe(409);
      expect(delRes.body.error.code).toBe('PERIOD_CLOSED');
    });

    it('lists returns and gets return by id', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
      });

      const createRes = await authedPost('/api/v1/stock-returns', {
        productId: lemperId,
        qtyPcs: 2,
        date: '2026-10-04',
      });
      const returnId = createRes.body.data.id;

      const listRes = await authedGet('/api/v1/stock-returns');
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBe(1);

      const getRes = await authedGet(`/api/v1/stock-returns/${returnId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.id).toBe(returnId);
      expect(getRes.body.data.qtyPcs).toBe(2);
    });
  });
});
