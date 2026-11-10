import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { createStockInPaymentService } from '../services/stock-in-payment.service.js';
import { AppError } from '../utils/errors.js';
import {
  createStockInPaymentSchema,
  parseIdempotencyKey,
  parseOrThrow,
} from '../validators/stock-in-payment.js';

export type StockInPaymentServiceInstance = ReturnType<typeof createStockInPaymentService>;

function parseId(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', 'ID barang masuk tidak valid.');
  }
  return id;
}

export function createStockInPaymentController(service: StockInPaymentServiceInstance) {
  return {
    async create(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const key = parseIdempotencyKey(req.get('idempotency-key'));
      const input = parseOrThrow(createStockInPaymentSchema, req.body);
      const user = getAuthUser(res);
      const { payment, replayed } = await service.recordPayment(user.id, id, key, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      if (replayed) res.set('Idempotent-Replayed', 'true');
      res.status(replayed ? 200 : 201).json({ data: payment });
    },

    async list(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const history = await service.getPaymentHistory(id);
      res.status(200).json({ data: history });
    },
  };
}
