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

describe('Consignors API (/api/v1/consignors)', () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    app = createApp({ pool, env, clock: () => T0 });
    sessionCookie = await loginAdmin();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Security & Authentication Guards', () => {
    it('returns 401 UNAUTHENTICATED when requesting without a session', async () => {
      const res = await request(app).get('/api/v1/consignors');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 403 CSRF_REJECTED when mutation request misses X-Requested-With', async () => {
      const res = await request(app)
        .post('/api/v1/consignors')
        .set('Cookie', `store_sid=${sessionCookie}`)
        .send({ name: 'Pak Sani' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    });
  });

  describe('POST /api/v1/consignors (Create)', () => {
    it('creates consignor with nominal default margin (Pak Sani)', async () => {
      const res = await authedPost('/api/v1/consignors', {
        name: 'Pak Sani',
        phone: '081234567890',
        note: 'Setor tiap Senin',
        defaultMarginType: 'nominal',
        defaultMarginValue: '1000',
      });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        name: 'Pak Sani',
        phone: '081234567890',
        note: 'Setor tiap Senin',
        defaultMarginType: 'nominal',
        defaultMarginValue: '1000.0000',
        isActive: true,
      });
      expect(typeof res.body.data.id).toBe('number');
    });

    it('creates consignor with percent default margin (Kak Peja)', async () => {
      const res = await authedPost('/api/v1/consignors', {
        name: 'Kak Peja',
        phone: '08987654321',
        defaultMarginType: 'percent',
        defaultMarginValue: '3.65',
      });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        name: 'Kak Peja',
        defaultMarginType: 'percent',
        defaultMarginValue: '3.6500',
        isActive: true,
      });
    });

    it('creates consignor without default margin scheme', async () => {
      const res = await authedPost('/api/v1/consignors', {
        name: 'Mitra Baru',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Mitra Baru');
      expect(res.body.data.defaultMarginType).toBeNull();
      expect(res.body.data.defaultMarginValue).toBeNull();
    });

    it('rejects duplicate consignor name with 409 CONSIGNOR_NAME_EXISTS', async () => {
      await authedPost('/api/v1/consignors', { name: 'Pak Sani' });

      // Case-insensitive duplicate attempt
      const res = await authedPost('/api/v1/consignors', { name: 'pak sani' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONSIGNOR_NAME_EXISTS');
      expect(res.body.error.message).toContain('sudah terdaftar');
    });

    it('rejects invalid inputs with 400 VALIDATION_ERROR', async () => {
      // Empty name
      const res1 = await authedPost('/api/v1/consignors', { name: '   ' });
      expect(res1.status).toBe(400);
      expect(res1.body.error.code).toBe('VALIDATION_ERROR');

      // Margin type without value
      const res2 = await authedPost('/api/v1/consignors', {
        name: 'Test',
        defaultMarginType: 'nominal',
      });
      expect(res2.status).toBe(400);

      // Margin percent out of bounds (>= 100)
      const res3 = await authedPost('/api/v1/consignors', {
        name: 'Test',
        defaultMarginType: 'percent',
        defaultMarginValue: '100',
      });
      expect(res3.status).toBe(400);

      // Margin nominal negative
      const res4 = await authedPost('/api/v1/consignors', {
        name: 'Test',
        defaultMarginType: 'nominal',
        defaultMarginValue: '-500',
      });
      expect(res4.status).toBe(400);
    });
  });

  describe('GET /api/v1/consignors (List & Filter)', () => {
    beforeEach(async () => {
      await authedPost('/api/v1/consignors', { name: 'Pak Sani' });
      await authedPost('/api/v1/consignors', { name: 'Kak Peja' });
      const c3 = await authedPost('/api/v1/consignors', { name: 'Ibu Budi' });
      // Deactivate Ibu Budi
      await authedPatch(`/api/v1/consignors/${c3.body.data.id}/status`, { isActive: false });
    });

    it('lists active consignors by default', async () => {
      const res = await authedGet('/api/v1/consignors');
      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(2);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data.every((c: { isActive: boolean }) => c.isActive)).toBe(true);
    });

    it('filters by status=inactive', async () => {
      const res = await authedGet('/api/v1/consignors?status=inactive');
      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(1);
      expect(res.body.data[0].name).toBe('Ibu Budi');
    });

    it('filters by status=all', async () => {
      const res = await authedGet('/api/v1/consignors?status=all');
      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(3);
    });

    it('searches by name', async () => {
      const res = await authedGet('/api/v1/consignors?search=sani');
      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(1);
      expect(res.body.data[0].name).toBe('Pak Sani');
    });

    it('paginates results', async () => {
      const res = await authedGet('/api/v1/consignors?status=all&limit=2&page=1');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.pagination.totalPages).toBe(2);
    });
  });

  describe('GET /api/v1/consignors/:id (Detail)', () => {
    it('retrieves consignor by id', async () => {
      const created = await authedPost('/api/v1/consignors', { name: 'Pak Sani' });
      const id = created.body.data.id;

      const res = await authedGet(`/api/v1/consignors/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(res.body.data.name).toBe('Pak Sani');
    });

    it('returns 404 CONSIGNOR_NOT_FOUND when ID does not exist', async () => {
      const res = await authedGet('/api/v1/consignors/99999');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CONSIGNOR_NOT_FOUND');
    });

    it('returns 400 INVALID_ID for non-numeric ID', async () => {
      const res = await authedGet('/api/v1/consignors/invalid');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ID');
    });
  });

  describe('PUT /api/v1/consignors/:id (Update)', () => {
    it('updates consignor attributes', async () => {
      const created = await authedPost('/api/v1/consignors', { name: 'Pak Sani' });
      const id = created.body.data.id;

      const res = await authedPut(`/api/v1/consignors/${id}`, {
        name: 'Pak Sani (Updated)',
        phone: '0811111111',
        note: 'Ganti jadwal',
        defaultMarginType: 'nominal',
        defaultMarginValue: '1500',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Pak Sani (Updated)');
      expect(res.body.data.phone).toBe('0811111111');
      expect(res.body.data.note).toBe('Ganti jadwal');
      expect(res.body.data.defaultMarginValue).toBe('1500.0000');
    });

    it('rejects rename if new name collides with another consignor', async () => {
      await authedPost('/api/v1/consignors', { name: 'Pak Sani' });
      const peja = await authedPost('/api/v1/consignors', { name: 'Kak Peja' });

      const res = await authedPut(`/api/v1/consignors/${peja.body.data.id}`, {
        name: 'Pak Sani',
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONSIGNOR_NAME_EXISTS');
    });

    it('allows updating other fields without changing name', async () => {
      const created = await authedPost('/api/v1/consignors', { name: 'Pak Sani' });
      const id = created.body.data.id;

      const res = await authedPut(`/api/v1/consignors/${id}`, {
        name: 'Pak Sani',
        phone: '08222222',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBe('08222222');
    });
  });

  describe('PATCH /api/v1/consignors/:id/status (Soft Delete & Restore)', () => {
    it('soft deletes (deactivates) and restores (activates) a consignor', async () => {
      const created = await authedPost('/api/v1/consignors', { name: 'Pak Sani' });
      const id = created.body.data.id;

      // Deactivate
      const deact = await authedPatch(`/api/v1/consignors/${id}/status`, { isActive: false });
      expect(deact.status).toBe(200);
      expect(deact.body.data.isActive).toBe(false);

      // Verify in DB that row is NOT deleted
      const [rows] = await pool.query<RowDataPacket[]>('SELECT is_active FROM consignors WHERE id = ?', [id]);
      expect(rows.length).toBe(1);
      expect(rows[0]!.is_active).toBe(0);

      // Restore
      const react = await authedPatch(`/api/v1/consignors/${id}/status`, { isActive: true });
      expect(react.status).toBe(200);
      expect(react.body.data.isActive).toBe(true);
    });

    it('returns 404 when setting status on unknown id', async () => {
      const res = await authedPatch('/api/v1/consignors/99999/status', { isActive: false });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CONSIGNOR_NOT_FOUND');
    });
  });

  describe('Audit Logging Verification', () => {
    it('records audit log entries on create, update, and status change', async () => {
      const created = await authedPost('/api/v1/consignors', { name: 'Pak Sani' });
      const id = created.body.data.id;

      await authedPut(`/api/v1/consignors/${id}`, { phone: '081234' });
      await authedPatch(`/api/v1/consignors/${id}/status`, { isActive: false });

      const [logs] = await pool.query<RowDataPacket[]>(
        'SELECT action, entity_type, entity_id FROM audit_log WHERE entity_type = "consignor" ORDER BY id ASC',
      );

      expect(logs.length).toBe(3);
      expect(logs[0]).toMatchObject({
        action: 'consignor.created',
        entity_type: 'consignor',
        entity_id: String(id),
      });
      expect(logs[1]).toMatchObject({
        action: 'consignor.updated',
        entity_type: 'consignor',
        entity_id: String(id),
      });
      expect(logs[2]).toMatchObject({
        action: 'consignor.status_changed',
        entity_type: 'consignor',
        entity_id: String(id),
      });
    });
  });
});
