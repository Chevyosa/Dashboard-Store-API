import { Router } from 'express';
import type { createTakeProfitController } from '../controllers/take-profit.controller.js';

export type TakeProfitController = ReturnType<typeof createTakeProfitController>;

export function createTakeProfitRouter(controller: TakeProfitController): Router {
  const router = Router();

  router.get('/take-profits/overview', (req, res, next) => {
    controller.getOverview(req, res).catch(next);
  });

  router.put('/take-profits/settings/working-capital', (req, res, next) => {
    controller.updateWorkingCapital(req, res).catch(next);
  });

  router.get('/take-profits', (req, res, next) => {
    controller.listTakeProfits(req, res).catch(next);
  });

  router.post('/take-profits', (req, res, next) => {
    controller.createTakeProfit(req, res).catch(next);
  });

  router.delete('/take-profits/:id', (req, res, next) => {
    controller.deleteTakeProfit(req, res).catch(next);
  });

  return router;
}
