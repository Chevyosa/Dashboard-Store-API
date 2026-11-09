import { Router } from 'express';
import type { createLossController } from '../controllers/loss.controller.js';

export type LossController = ReturnType<typeof createLossController>;

export function createLossRouter(controller: LossController): Router {
  const router = Router();

  router.get('/losses/summary/open-period', (req, res, next) => {
    controller.getSummary(req, res).catch(next);
  });

  router.get('/losses', (req, res, next) => {
    controller.list(req, res).catch(next);
  });

  router.post('/losses', (req, res, next) => {
    controller.create(req, res).catch(next);
  });

  router.get('/losses/:id', (req, res, next) => {
    controller.getById(req, res).catch(next);
  });

  router.put('/losses/:id', (req, res, next) => {
    controller.update(req, res).catch(next);
  });

  router.delete('/losses/:id', (req, res, next) => {
    controller.delete(req, res).catch(next);
  });

  return router;
}
