import request from 'supertest';
import type { Pool } from 'mysql2/promise';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestPool, getTestEnv } from '../helpers/db.js';

describe('health endpoints', () => {
  const pool = createTestPool();
  const app = createApp({ pool, env: getTestEnv() });

  afterAll(async () => {
    await pool.end();
  });

  describe('GET /health', () => {
    it('returns ok without auth or sensitive data', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('returns uniform 404 error format for unknown routes', async () => {
      const res = await request(app).get('/nope');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /health/db', () => {
    it('returns 200 ok and db connected when database is responsive', async () => {
      const res = await request(app).get('/health/db');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', db: 'connected' });
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('returns 503 disconnected without leaking error details when DB fails', async () => {
      const brokenPool = {
        query: vi.fn().mockRejectedValue(new Error('Koneksi terputus: password=secret123')),
      } as unknown as Pool;

      const brokenApp = createApp({ pool: brokenPool, env: getTestEnv() });
      const res = await request(brokenApp).get('/health/db');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'error', db: 'disconnected' });
      expect(res.text).not.toContain('secret123');
      expect(res.text).not.toContain('password');
      expect(res.text).not.toContain('stack');
    });
  });
});
