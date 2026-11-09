import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { createPayoutService } from '../services/payout.service.js';
import { AppError } from '../utils/errors.js';
import {
  createConsignorPaymentSchema,
  listConsignorPaymentsQuerySchema,
  listConsignorLedgerQuerySchema,
  parseOrThrow,
} from '../validators/payout.js';

export type PayoutServiceInstance = ReturnType<typeof createPayoutService>;

function parseId(param: string | string[] | undefined, name = 'ID'): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', `${name} tidak valid.`);
  }
  return id;
}

export function createPayoutController(service: PayoutServiceInstance) {
  return {
    async createPayment(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(createConsignorPaymentSchema, req.body);
      const user = getAuthUser(res);
      const payment = await service.recordPayment(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(201).json({ data: payment });
    },

    async listPayments(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(listConsignorPaymentsQuerySchema, req.query);
      const result = await service.listPayments(query);
      res.status(200).json({ data: result.data, pagination: result.pagination });
    },

    async deletePayment(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id, 'ID pembayaran');
      const user = getAuthUser(res);
      await service.deletePayment(user.id, id, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ message: 'Bukti pembayaran berhasil dihapus.' });
    },

    async getConsignorLedger(req: Request, res: Response): Promise<void> {
      const consignorId = parseId(req.params.consignorId, 'ID penitip');
      const detail = await service.getConsignorLedger(consignorId);
      res.status(200).json({ data: detail });
    },

    async listConsignorLedgers(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(listConsignorLedgerQuerySchema, req.query);
      const result = await service.listConsignorLedgers(query);
      res.status(200).json({ data: result });
    },
  };
}
