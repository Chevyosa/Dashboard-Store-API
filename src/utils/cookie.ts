import { parseCookie, stringifySetCookie } from 'cookie';
import { ABSOLUTE_TIMEOUT_MS } from './time.js';

export const SESSION_COOKIE = 'store_sid';

export interface CookieSettings {
  secure: boolean;
  domain: string | undefined;
}

export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  const value = parseCookie(cookieHeader)[SESSION_COOKIE];
  return value === undefined || value === '' ? undefined : value;
}

function base(settings: CookieSettings) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: settings.secure,
    ...(settings.domain === undefined ? {} : { domain: settings.domain }),
  };
}

export function buildSessionCookie(token: string, settings: CookieSettings): string {
  return stringifySetCookie({
    ...base(settings),
    value: token,
    maxAge: Math.floor(ABSOLUTE_TIMEOUT_MS / 1000),
  });
}

export function buildClearedSessionCookie(settings: CookieSettings): string {
  return stringifySetCookie({ ...base(settings), value: '', maxAge: 0 });
}
