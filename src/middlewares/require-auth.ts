import type { RequestHandler, Response } from 'express';
import type { AuthService, AuthUser } from '../services/auth.service.js';
import { AppError } from '../utils/errors.js';
import { readSessionToken } from '../utils/cookie.js';

export function requireAuth(authService: AuthService): RequestHandler {
  return async (req, res, next) => {
    try {
      const user = await authService.authenticate(readSessionToken(req.headers.cookie));
      if (user === null) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid. Silakan masuk lagi.');
      }
      res.locals.auth = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function getAuthUser(res: Response): AuthUser {
  return res.locals.auth as AuthUser;
}
