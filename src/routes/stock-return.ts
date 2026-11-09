import { Router } from 'express';
import type { createStockReturnController } from '../controllers/stock-return.controller.js';

export type StockReturnController = ReturnType<typeof createStockReturnController>;

export function createStockReturnRouter(controller: StockReturnController): Router {
  const router = Router();

  router.get('/stock-returns', (req, res, next) => {
    controller.list(req, res).catch(next);
  });

  router.post('/stock-returns', (req, res, next) => {
    controller.create(req, res).catch(next);
  });

  router.get('/stock-returns/:id', (req, res, next) => {
    controller.getById(req, res).catch(next);
  });

  router.put('/stock-returns/:id', (req, res, next) => {
    controller.update(req, res).catch(next);
  });

  router.delete('/stock-returns/:id', (req, res, next) => {
    controller.delete(req, res).catch(next);
  });

  return router;
}
