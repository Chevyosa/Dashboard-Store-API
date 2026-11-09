import { Router } from 'express';
import type { ConsignorController } from '../controllers/consignor.controller.js';

export function createConsignorRouter(controller: ConsignorController): Router {
  const router = Router();

  router.get('/consignors', (req, res, next) => {
    controller.list(req, res).catch(next);
  });

  router.get('/consignors/:id', (req, res, next) => {
    controller.getById(req, res).catch(next);
  });

  router.post('/consignors', (req, res, next) => {
    controller.create(req, res).catch(next);
  });

  router.put('/consignors/:id', (req, res, next) => {
    controller.update(req, res).catch(next);
  });

  router.patch('/consignors/:id/status', (req, res, next) => {
    controller.setStatus(req, res).catch(next);
  });

  return router;
}
