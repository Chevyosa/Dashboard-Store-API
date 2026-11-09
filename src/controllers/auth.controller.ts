import type { Request, RequestHandler } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { AuthService, ClientInfo } from '../services/auth.service.js';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  readSessionToken,
} from '../utils/cookie.js';
import type { CookieSettings } from '../utils/cookie.js';
import { loginSchema, parseOrThrow } from '../validators/auth.js';

function clientInfo(req: Request): ClientInfo {
  const ua = req.get('user-agent');
  return { ip: req.ip ?? null, userAgent: ua === undefined ? null : ua.slice(0, 255) };
}

export function createAuthController(authService: AuthService, cookies: CookieSettings) {
  const login: RequestHandler = async (req, res, next) => {
    try {
      const body = parseOrThrow(loginSchema, req.body);
      const { token, user } = await authService.login({
        ...body,
        previousToken: readSessionToken(req.headers.cookie),
        client: clientInfo(req),
      });
      res.setHeader('Set-Cookie', buildSessionCookie(token, cookies));
      res.status(200).json({ user });
    } catch (err) {
      next(err);
    }
  };

  const logout: RequestHandler = async (req, res, next) => {
    try {
      await authService.logout(readSessionToken(req.headers.cookie), clientInfo(req));
      res.setHeader('Set-Cookie', buildClearedSessionCookie(cookies));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };

  const me: RequestHandler = (_req, res) => {
    res.status(200).json({ user: getAuthUser(res) });
  };

  return { login, logout, me };
}
