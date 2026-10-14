import { Router } from 'express';
import type { createPayoutController } from '../controllers/payout.controller.js';

export type PayoutController = ReturnType<typeof createPayoutController>;

export function createPayoutRouter(controller: PayoutController): Router {
  const router = Router();

  router.get('/payouts/ledgers', (req, res, next) => {
    controller.listConsignorLedgers(req, res).catch(next);
  });

  router.get('/payouts/ledgers/:consignorId', (req, res, next) => {
    controller.getConsignorLedger(req, res).catch(next);
  });

  router.get('/payouts/payments', (req, res, next) => {
    controller.listPayments(req, res).catch(next);
  });

  router.post('/payouts/payments', (req, res, next) => {
    controller.createPayment(req, res).catch(next);
  });

  router.delete('/payouts/payments/:id', (req, res, next) => {
    controller.deletePayment(req, res).catch(next);
  });

  return router;
}
