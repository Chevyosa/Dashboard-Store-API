import { Router } from 'express';
import type { createStockInController } from '../controllers/stock-in.controller.js';

export type StockInController = ReturnType<typeof createStockInController>;

export function createStockInRouter(controller: StockInController): Router {
  const router = Router();

  router.get('/stock-ins/summary/open-period', (req, res, next) => {
    controller.getOpenPeriodSummary(req, res).catch(next);
  });

  router.get('/stock-ins', (req, res, next) => {
    controller.list(req, res).catch(next);
  });

  router.post('/stock-ins', (req, res, next) => {
    controller.create(req, res).catch(next);
  });

  router.get('/stock-ins/:id', (req, res, next) => {
    controller.getById(req, res).catch(next);
  });

  router.put('/stock-ins/:id', (req, res, next) => {
    controller.update(req, res).catch(next);
  });

  router.delete('/stock-ins/:id', (req, res, next) => {
    controller.delete(req, res).catch(next);
  });

  return router;
}
