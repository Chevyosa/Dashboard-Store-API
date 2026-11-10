import { Router } from 'express';
import type { createStockInPaymentController } from '../controllers/stock-in-payment.controller.js';

export type StockInPaymentController = ReturnType<typeof createStockInPaymentController>;

// Payment history is append-only: no PUT/DELETE routes by design.
export function createStockInPaymentRouter(controller: StockInPaymentController): Router {
  const router = Router();

  router.get('/stock-ins/:id/payments', (req, res, next) => {
    controller.list(req, res).catch(next);
  });

  router.post('/stock-ins/:id/payments', (req, res, next) => {
    controller.create(req, res).catch(next);
  });

  return router;
}
