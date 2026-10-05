import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { createLossService } from '../services/loss.service.js';
import { AppError } from '../utils/errors.js';
import {
  createLossSchema,
  updateLossSchema,
  listLossesQuerySchema,
  parseOrThrow,
} from '../validators/loss.js';

export type LossServiceInstance = ReturnType<typeof createLossService>;

function parseId(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', 'ID loss tidak valid.');
  }
  return id;
}

export function createLossController(service: LossServiceInstance) {
  return {
    async create(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(createLossSchema, req.body);
      const user = getAuthUser(res);
      const loss = await service.createLoss(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(201).json({ data: loss });
    },

    async list(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(listLossesQuerySchema, req.query);
      const result = await service.listLosses(query);
      res.status(200).json({ data: result.data, pagination: result.pagination });
    },

    async getSummary(req: Request, res: Response): Promise<void> {
      const summary = await service.getOpenPeriodSummary();
      res.status(200).json({ data: summary });
    },

    async getById(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const loss = await service.getLossById(id);
      res.status(200).json({ data: loss });
    },

    async update(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const input = parseOrThrow(updateLossSchema, req.body);
      const user = getAuthUser(res);
      const loss = await service.updateLoss(user.id, id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ data: loss });
    },

    async delete(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const user = getAuthUser(res);
      await service.deleteLoss(user.id, id, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ message: 'Data loss berhasil dihapus.' });
    },
  };
}
