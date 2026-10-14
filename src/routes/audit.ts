import { Router } from 'express';
import type { createAuditController } from '../controllers/audit.controller.js';

export type AuditController = ReturnType<typeof createAuditController>;

export function createAuditRouter(controller: AuditController): Router {
  const router = Router();

  router.get('/audit-logs', (req, res, next) => {
    controller.list(req, res).catch(next);
  });

  router.get('/audit-logs/filters', (req, res, next) => {
    controller.getFilters(req, res).catch(next);
  });

  router.get('/audit-logs/:id', (req, res, next) => {
    controller.getById(req, res).catch(next);
  });

  return router;
}
