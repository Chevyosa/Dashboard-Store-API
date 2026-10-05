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

describe('Loss API (/api/v1/losses)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('POST /api/v1/losses (Default Matrix & Business Rules §5.6)', () => {
    it('applies default borne_by for consignor products based on table §5.6', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
      });

      // 1. expired -> consignor
      const resExpired = await authedPost('/api/v1/losses', {
        productId: lemperId,
        qtyPcs: 2,
        reason: 'expired',
        date: '2026-10-04',
      });
      expect(resExpired.status).toBe(201);
      expect(resExpired.body.data.borneBy).toBe('consignor');

      // 2. damaged_on_display -> owner
      const resDisplay = await authedPost('/api/v1/losses', {
        productId: lemperId,
        qtyPcs: 1,
        reason: 'damaged_on_display',
        date: '2026-10-04',
      });
      expect(resDisplay.status).toBe(201);
      expect(resDisplay.body.data.borneBy).toBe('owner');

      // 3. damaged_before_display -> consignor
      const resBefore = await authedPost('/api/v1/losses', {
        productId: lemperId,
        qtyPcs: 1,
        reason: 'damaged_before_display',
        date: '2026-10-04',
      });
      expect(resBefore.status).toBe(201);
      expect(resBefore.body.data.borneBy).toBe('consignor');

      // 4. lost -> owner
      const resLost = await authedPost('/api/v1/losses', {
        productId: lemperId,
        qtyPcs: 1,
        reason: 'lost',
        date: '2026-10-04',
      });
      expect(resLost.status).toBe(201);
      expect(resLost.body.data.borneBy).toBe('owner');

      // 5. other -> owner
      const resOther = await authedPost('/api/v1/losses', {
        productId: lemperId,
        qtyPcs: 1,
        reason: 'other',
        date: '2026-10-04',
      });
      expect(resOther.status).toBe(201);
      expect(resOther.body.data.borneBy).toBe('owner');
    });

    it('allows overriding borne_by for consignor products', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
      });

      // Override expired to owner
      const res = await authedPost('/api/v1/losses', {
        productId: lemperId,
        qtyPcs: 3,
        reason: 'expired',
        borneBy: 'owner',
        date: '2026-10-04',
        note: 'Kebijakan owner mengganti rugi',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.borneBy).toBe('owner');
      expect(res.body.data.reason).toBe('expired');
    });

    it('locks own products to owner and rejects consignor borne_by', async () => {
      const ownId = await createTestProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
      });

      // Attempting consignor for own product -> REJECT 400
      const resReject = await authedPost('/api/v1/losses', {
        productId: ownId,
        qtyPcs: 1,
        reason: 'expired',
        borneBy: 'consignor',
        date: '2026-10-04',
      });

      expect(resReject.status).toBe(400);
      expect(resReject.body.error.code).toBe('INVALID_BORNE_BY');
      expect(resReject.body.error.message).toContain('Owner');

      // Allowed with default or owner
      const resOk = await authedPost('/api/v1/losses', {
        productId: ownId,
        qtyPcs: 2,
        reason: 'expired',
        date: '2026-10-04',
      });

      expect(resOk.status).toBe(201);
      expect(resOk.body.data.borneBy).toBe('owner');
    });

    it('validates quantity and product existence', async () => {
      const ownId = await createTestProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
      });

      // Negative or zero qty
      const resZero = await authedPost('/api/v1/losses', {
        productId: ownId,
        qtyPcs: 0,
        reason: 'lost',
        date: '2026-10-04',
      });
      expect(resZero.status).toBe(400);

      // Non-existent product
      const res404 = await authedPost('/api/v1/losses', {
        productId: 999999,
        qtyPcs: 1,
        reason: 'lost',
        date: '2026-10-04',
      });
      expect(res404.status).toBe(404);
      expect(res404.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  describe('GET /api/v1/losses & GET /api/v1/losses/summary/open-period', () => {
    it('returns filtered loss records and open period summary', async () => {
      const saniId = await createTestConsignor('Pak Sani');
      const lemperId = await createTestProduct({
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId: saniId,
        sellPrice: '7000.0000',
      });
      const ownId = await createTestProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
      });

      // Loss 1: Titipan expired 2 pcs (consignor)
      await authedPost('/api/v1/losses', {
        productId: lemperId,
        qtyPcs: 2,
        reason: 'expired',
        date: '2026-10-02',
      });

      // Loss 2: Own lost 1 pcs (owner)
      await authedPost('/api/v1/losses', {
        productId: ownId,
        qtyPcs: 1,
        reason: 'lost',
        date: '2026-10-03',
      });

      // Test List
      const listRes = await authedGet('/api/v1/losses');
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBe(2);
      expect(listRes.body.pagination.total).toBe(2);

      // Test Filter by borneBy
      const filterRes = await authedGet('/api/v1/losses?borneBy=owner');
      expect(filterRes.status).toBe(200);
      expect(filterRes.body.data.length).toBe(1);
      expect(filterRes.body.data[0].productName).toBe('Gery Salut');

      // Test Summary
      const summaryRes = await authedGet('/api/v1/losses/summary/open-period');
      expect(summaryRes.status).toBe(200);
      expect(summaryRes.body.data.totalPcs).toBe(3);
      expect(summaryRes.body.data.totalRecords).toBe(2);
      expect(summaryRes.body.data.totalOwnerBornePcs).toBe(1);
      expect(summaryRes.body.data.totalConsignorBornePcs).toBe(2);
      expect(summaryRes.body.data.breakdownByReason.expired).toBe(2);
      expect(summaryRes.body.data.breakdownByReason.lost).toBe(1);
    });
  });

  describe('PUT & DELETE /api/v1/losses/:id', () => {
    it('updates and deletes loss in open period and records audit', async () => {
      const ownId = await createTestProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
      });

      const createRes = await authedPost('/api/v1/losses', {
        productId: ownId,
        qtyPcs: 2,
        reason: 'damaged_on_display',
        date: '2026-10-04',
        note: 'Tertindih',
      });
      const lossId = createRes.body.data.id;

      // Update
      const updateRes = await authedPut(`/api/v1/losses/${lossId}`, {
        qtyPcs: 3,
        note: 'Revisi jumlah tertindih',
      });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.qtyPcs).toBe(3);
      expect(updateRes.body.data.note).toBe('Revisi jumlah tertindih');

      // Check Audit Log
      const [logs] = await pool.query<RowDataPacket[]>(
        'SELECT action, entity_id FROM audit_log WHERE entity_type = "loss" ORDER BY id ASC',
      );
      expect(logs.length).toBe(2);
      expect(logs[0]?.action).toBe('loss.created');
      expect(logs[1]?.action).toBe('loss.updated');

      // Delete
      const deleteRes = await authedDelete(`/api/v1/losses/${lossId}`);
      expect(deleteRes.status).toBe(200);

      const checkRes = await authedGet(`/api/v1/losses/${lossId}`);
      expect(checkRes.status).toBe(404);
    });

    it('rejects update and delete when period is closed (opname_id != null)', async () => {
      const ownId = await createTestProduct({
        name: 'Gery Salut',
        ownerType: 'own',
        sellPrice: '1500.0000',
      });

      const createRes = await authedPost('/api/v1/losses', {
        productId: ownId,
        qtyPcs: 1,
        reason: 'lost',
        date: '2026-10-04',
      });
      const lossId = createRes.body.data.id;

      // Simulate period closed
      await pool.execute('UPDATE loss_records SET opname_id = 99 WHERE id = ?', [lossId]);

      // Try update
      const updateRes = await authedPut(`/api/v1/losses/${lossId}`, { qtyPcs: 2 });
      expect(updateRes.status).toBe(409);
      expect(updateRes.body.error.code).toBe('PERIOD_CLOSED');

      // Try delete
      const deleteRes = await authedDelete(`/api/v1/losses/${lossId}`);
      expect(deleteRes.status).toBe(409);
      expect(deleteRes.body.error.code).toBe('PERIOD_CLOSED');
    });
  });
});
