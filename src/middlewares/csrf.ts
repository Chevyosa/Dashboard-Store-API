import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// SameSite=Lax is the first line of defence; state-changing requests also need a
// custom header (not sendable cross-origin without CORS approval) and a known Origin.
export function csrfProtection(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.get('origin');
    const header = req.get('x-requested-with');
    if (header !== 'XMLHttpRequest' || (origin !== undefined && !allowed.has(origin))) {
      next(new AppError(403, 'CSRF_REJECTED', 'Permintaan ditolak.'));
      return;
    }
    next();
  };
}
