import { describe, expect, it } from 'vitest';
import { EnvError, corsOrigins, loadEnv } from '../../src/config/env.js';

const valid = {
  NODE_ENV: 'test',
  PORT: '4000',
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_USER: 'u',
  DB_PASSWORD: '',
  DB_NAME: 'store_test',
  DB_CONNECTION_LIMIT: '5',
  SESSION_SECRET: 'x'.repeat(32),
  CORS_ORIGIN: 'http://localhost:3000',
  COOKIE_DOMAIN: '',
  LOG_LEVEL: 'info',
};

describe('loadEnv', () => {
  it('parses a complete env and coerces numbers', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.DB_CONNECTION_LIMIT).toBe(5);
    expect(env.COOKIE_DOMAIN).toBeUndefined();
  });

  it('defaults TRUST_PROXY to 0 and accepts hop counts', () => {
    expect(loadEnv(valid).TRUST_PROXY).toBe(0);
    expect(loadEnv({ ...valid, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(() => loadEnv({ ...valid, TRUST_PROXY: '-1' })).toThrow(EnvError);
  });

  it('splits CORS_ORIGIN on commas', () => {
    expect(corsOrigins({ CORS_ORIGIN: 'http://a.test, https://b.test ,' })).toEqual([
      'http://a.test',
      'https://b.test',
    ]);
  });

  it('fails fast listing every problem without leaking values', () => {
    const bad = { ...valid, SESSION_SECRET: 'short', DB_HOST: '' };
    let error: unknown;
    try {
      loadEnv(bad);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as EnvError).message;
    expect(message).toContain('SESSION_SECRET');
    expect(message).toContain('DB_HOST');
    expect(message).not.toContain('short');
  });

  it('fails when a required variable is missing', () => {
    const rest: Record<string, string> = { ...valid };
    delete rest.DB_NAME;
    expect(() => loadEnv(rest)).toThrow(EnvError);
  });
});
