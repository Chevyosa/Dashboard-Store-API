import { Router } from 'express';
import type { createLiquidityCutoverController } from '../controllers/liquidity-cutover.controller.js';

export type LiquidityCutoverController = ReturnType<typeof createLiquidityCutoverController>;

// One-time initialization only: no GET/PUT/DELETE for the cutover by design.
export function createLiquidityRouter(controller: LiquidityCutoverController): Router {
  const router = Router();

  router.post('/liquidity/cutover', (req, res, next) => {
    controller.initialize(req, res).catch(next);
  });

  return router;
}
