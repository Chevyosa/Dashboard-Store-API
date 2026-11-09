import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { createAuthController } from '../controllers/auth.controller.js';

type AuthController = ReturnType<typeof createAuthController>;

// login/logout work without a valid session; /me needs one (mounted after requireAuth).
export function createPublicAuthRouter(
  controller: AuthController,
  limiter: RequestHandler,
): Router {
  const router = Router();
  router.post('/login', limiter, controller.login);
  router.post('/logout', controller.logout);
  return router;
}

export function createProtectedAuthRouter(controller: AuthController): Router {
  const router = Router();
  router.get('/me', controller.me);
  return router;
}
