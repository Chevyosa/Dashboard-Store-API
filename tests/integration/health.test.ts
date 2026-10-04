import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestPool, getTestEnv } from '../helpers/db.js';

describe('GET /health', () => {
  const pool = createTestPool();
  const app = createApp({ pool, env: getTestEnv() });
  afterAll(async () => {
    await pool.end();
  });

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
