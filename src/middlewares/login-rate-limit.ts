import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';

export interface LoginRateLimitOptions {
  windowMs: number;
  limit: number;
}

export const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  limit: 10,
};

// Counts only failed attempts, so normal use of the app is never throttled.
export function loginRateLimit(options: LoginRateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Terlalu banyak percobaan masuk. Coba lagi dalam beberapa menit.',
          details: [],
        },
      });
    },
  });
}
