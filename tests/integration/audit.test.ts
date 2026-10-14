import type { Express } from 'express';
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

describe('Audit Trail API (/api/v1/audit-logs)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Security & Authentication Guards', () => {
    it('returns 401 UNAUTHENTICATED without session', async () => {
      const listRes = await request(app).get('/api/v1/audit-logs');
      expect(listRes.status).toBe(401);
      expect(listRes.body.error.code).toBe('UNAUTHENTICATED');

      const filterRes = await request(app).get('/api/v1/audit-logs/filters');
      expect(filterRes.status).toBe(401);

      const detailRes = await request(app).get('/api/v1/audit-logs/1');
      expect(detailRes.status).toBe(401);
    });
  });

  describe('GET /api/v1/audit-logs (Listing & Pagination)', () => {
    it('lists audit logs generated from product and consignor operations', async () => {
      // 1. Create consignor
      const consignorRes = await authedPost('/api/v1/consignors', {
        name: 'Pak Sani',
        phone: '08123456789',
        defaultMarginType: 'nominal',
        defaultMarginValue: '1000.0000',
      });
      const consignorId = consignorRes.body.data.id;

      // 2. Create product
      await authedPost('/api/v1/products', {
        name: 'Lemper Ayam',
        ownerType: 'consignor',
        consignorId,
        sellPrice: '7000.0000',
        marginType: 'nominal',
        marginValue: '1000.0000',
      });

      // 3. Fetch audit logs
      const res = await authedGet('/api/v1/audit-logs');
      expect(res.status).toBe(200);

      const { data, pagination } = res.body;
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(3); // admin create + login_success + consignor.created + product.created

      // Verify that usernames and actions are captured
      const productLog = data.find((l: { action: string }) => l.action === 'product.created');
      expect(productLog).toBeDefined();
      expect(productLog.username).toBe('owner');
      expect(productLog.entityType).toBe('product');
      expect(productLog.after).toHaveProperty('name', 'Lemper Ayam');

      const consignorLog = data.find((l: { action: string }) => l.action === 'consignor.created');
      expect(consignorLog).toBeDefined();
      expect(consignorLog.entityType).toBe('consignor');

      expect(pagination.total).toBeGreaterThanOrEqual(3);
      expect(pagination.page).toBe(1);
      expect(pagination.limit).toBe(20);
    });

    it('filters audit logs by action and entityType', async () => {
      await authedPost('/api/v1/consignors', {
        name: 'Pak Sani',
        phone: '08123456789',
      });

      const res = await authedGet('/api/v1/audit-logs?action=consignor.created');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].action).toBe('consignor.created');

      const noRes = await authedGet('/api/v1/audit-logs?action=non_existent_action');
      expect(noRes.status).toBe(200);
      expect(noRes.body.data.length).toBe(0);
    });

    it('searches audit logs by keyword', async () => {
      await authedPost('/api/v1/consignors', {
        name: 'Pak Sani Unik',
        phone: '08123456789',
      });

      const res = await authedGet('/api/v1/audit-logs?search=consignor');
      expect(res.status).toBe(200);
      expect(res.body.data.some((l: { action: string }) => l.action === 'consignor.created')).toBe(true);
    });
  });

  describe('GET /api/v1/audit-logs/filters', () => {
    it('returns distinct actions and entityTypes present in the database', async () => {
      await authedPost('/api/v1/consignors', {
        name: 'Pak Sani',
      });

      const res = await authedGet('/api/v1/audit-logs/filters');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.actions)).toBe(true);
      expect(Array.isArray(res.body.data.entityTypes)).toBe(true);
      expect(res.body.data.actions).toContain('consignor.created');
      expect(res.body.data.entityTypes).toContain('consignor');
    });
  });

  describe('GET /api/v1/audit-logs/:id (Detail & Snapshots)', () => {
    it('retrieves detailed audit log entry with before and after states', async () => {
      const consignorRes = await authedPost('/api/v1/consignors', {
        name: 'Pak Sani',
        phone: '08123456789',
      });
      const consignorId = consignorRes.body.data.id;

      // Update consignor to generate before and after states
      await request(app)
        .put(`/api/v1/consignors/${consignorId}`)
        .set('Cookie', `store_sid=${sessionCookie}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ name: 'Pak Sani Mart', phone: '0899999999' });

      // Find the update audit log ID
      const listRes = await authedGet(`/api/v1/audit-logs?action=consignor.updated`);
      const updateLog = listRes.body.data[0];
      expect(updateLog).toBeDefined();

      const detailRes = await authedGet(`/api/v1/audit-logs/${updateLog.id}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data.id).toBe(updateLog.id);
      expect(detailRes.body.data.before).toHaveProperty('name', 'Pak Sani');
      expect(detailRes.body.data.after).toHaveProperty('name', 'Pak Sani Mart');
    });

    it('returns 404 AUDIT_LOG_NOT_FOUND when log id does not exist', async () => {
      const res = await authedGet('/api/v1/audit-logs/999999');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('AUDIT_LOG_NOT_FOUND');
    });

    it('returns 400 INVALID_ID when log id is invalid', async () => {
      const res = await authedGet('/api/v1/audit-logs/not-a-number');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ID');
    });
  });
});
