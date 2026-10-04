import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import type { Pool } from 'mysql2/promise';
import { corsOrigins } from './config/env.js';
import type { Env } from './config/env.js';
import { createAuthController } from './controllers/auth.controller.js';
import { csrfProtection } from './middlewares/csrf.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';
import { DEFAULT_LOGIN_RATE_LIMIT, loginRateLimit } from './middlewares/login-rate-limit.js';
import type { LoginRateLimitOptions } from './middlewares/login-rate-limit.js';
import { requireAuth } from './middlewares/require-auth.js';
import { createProtectedAuthRouter, createPublicAuthRouter } from './routes/auth.js';
import { createHealthRouter } from './routes/health.js';
import { createAuthService } from './services/auth.service.js';
import type { Clock } from './utils/time.js';

export interface AppDeps {
  pool: Pool;
  env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGIN' | 'COOKIE_DOMAIN' | 'TRUST_PROXY'>;
  // Injectable so tests can move time and skip real delays.
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  loginRateLimit?: LoginRateLimitOptions;
}

// Builds the Express instance without listening, so tests can import it.
export function createApp(deps: AppDeps): Express {
  const { pool, env } = deps;
  const origins = corsOrigins(env);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: '100kb' }));

  app.use(createHealthRouter(pool));

  const authService = createAuthService({
    pool,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  const authController = createAuthController(authService, {
    secure: env.NODE_ENV === 'production',
    domain: env.COOKIE_DOMAIN,
  });
  const limiter = loginRateLimit(deps.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT);

  // Everything under /api/v1 needs a session except login/logout (AGENTS.md §8).
  // requireAuth sits before the 404 handler so unknown routes do not leak without a session.
  const api = express.Router();
  api.use(csrfProtection(origins));
  api.use('/auth', createPublicAuthRouter(authController, limiter));
  api.use(requireAuth(authService));
  api.use('/auth', createProtectedAuthRouter(authController));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
