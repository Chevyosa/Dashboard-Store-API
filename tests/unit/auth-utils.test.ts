import { describe, expect, it } from 'vitest';
import { loginDelayMs } from '../../src/services/auth.service.js';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  readSessionToken,
} from '../../src/utils/cookie.js';
import { fromMysqlUtc, toMysqlUtc } from '../../src/utils/time.js';
import { generateSessionToken, hashToken } from '../../src/utils/token.js';

describe('token', () => {
  it('generates 256-bit URL-safe tokens that never repeat', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes to a deterministic 64-char hex SHA-256', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });
});

describe('time helpers', () => {
  it('round-trips UTC DATETIME(3) strings', () => {
    const d = new Date('2026-03-02T09:00:01.234Z');
    expect(toMysqlUtc(d)).toBe('2026-03-02 09:00:01.234');
    expect(fromMysqlUtc('2026-03-02 09:00:01.234').getTime()).toBe(d.getTime());
  });
});

describe('loginDelayMs', () => {
  it.each([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 500],
    [4, 1000],
    [5, 2000],
    [6, 4000],
    [7, 8000],
    [8, 8000],
    [50, 8000],
  ])('%i failures -> %i ms', (failures, expected) => {
    expect(loginDelayMs(failures)).toBe(expected);
  });
});

describe('session cookie', () => {
  it('reads only the session cookie from a header', () => {
    expect(readSessionToken('a=1; store_sid=tok; b=2')).toBe('tok');
    expect(readSessionToken('a=1')).toBeUndefined();
    expect(readSessionToken(undefined)).toBeUndefined();
    expect(readSessionToken('store_sid=')).toBeUndefined();
  });

  it('builds a set and a cleared cookie with the right flags', () => {
    const set = buildSessionCookie('tok', { secure: true, domain: undefined });
    expect(set).toContain('store_sid=tok');
    expect(set).toContain('Secure');
    expect(set).toContain('HttpOnly');
    expect(set).not.toContain('Domain');
    expect(buildClearedSessionCookie({ secure: false, domain: undefined })).toContain('Max-Age=0');
  });
});
