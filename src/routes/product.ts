import { Router } from 'express';
import type { createProductController } from '../controllers/product.controller.js';

export type ProductController = ReturnType<typeof createProductController>;

export function createProductRouter(controller: ProductController): Router {
  const router = Router();

  router.post('/products/preview', (req, res, next) => {
    controller.previewMargin(req, res).catch(next);
  });

  router.get('/products', (req, res, next) => {
    controller.list(req, res).catch(next);
  });

  router.get('/products/:id', (req, res, next) => {
    controller.getById(req, res).catch(next);
  });

  router.post('/products', (req, res, next) => {
    controller.create(req, res).catch(next);
  });

  router.put('/products/:id', (req, res, next) => {
    controller.update(req, res).catch(next);
  });

  router.patch('/products/:id/status', (req, res, next) => {
    controller.setStatus(req, res).catch(next);
  });

  return router;
}
