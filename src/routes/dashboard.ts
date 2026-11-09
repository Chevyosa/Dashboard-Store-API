import { Router } from 'express';
import type { createDashboardController } from '../controllers/dashboard.controller.js';

export type DashboardController = ReturnType<typeof createDashboardController>;

export function createDashboardRouter(controller: DashboardController): Router {
  const router = Router();

  router.get('/dashboard/summary', (req, res, next) => {
    controller.getSummary(req, res).catch(next);
  });

  router.post('/dashboard/reconciliation', (req, res, next) => {
    controller.reconcile(req, res).catch(next);
  });

  return router;
}
