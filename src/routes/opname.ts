import { Router } from 'express';
import type { createOpnameController } from '../controllers/opname.controller.js';

export type OpnameController = ReturnType<typeof createOpnameController>;

export function createOpnameRouter(controller: OpnameController): Router {
  const router = Router();

  router.get('/opnames/prepare', (req, res, next) => {
    controller.prepare(req, res).catch(next);
  });

  router.post('/opnames/calculate', (req, res, next) => {
    controller.calculate(req, res).catch(next);
  });

  router.post('/opnames/draft', (req, res, next) => {
    controller.saveDraft(req, res).catch(next);
  });

  router.post('/opnames/finalize', (req, res, next) => {
    controller.finalize(req, res).catch(next);
  });

  router.get('/opnames', (req, res, next) => {
    controller.list(req, res).catch(next);
  });

  router.get('/opnames/:id', (req, res, next) => {
    controller.getById(req, res).catch(next);
  });

  router.delete('/opnames/:id/draft', (req, res, next) => {
    controller.deleteDraft(req, res).catch(next);
  });

  return router;
}
