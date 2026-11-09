import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { createTakeProfitService } from '../services/take-profit.service.js';
import { AppError } from '../utils/errors.js';
import {
  createTakeProfitSchema,
  listTakeProfitsQuerySchema,
  updateWorkingCapitalSchema,
  parseOrThrow,
} from '../validators/take-profit.js';

export type TakeProfitServiceInstance = ReturnType<typeof createTakeProfitService>;

function parseId(param: string | string[] | undefined, name = 'ID'): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', `${name} tidak valid.`);
  }
  return id;
}

export function createTakeProfitController(service: TakeProfitServiceInstance) {
  return {
    async getOverview(_req: Request, res: Response): Promise<void> {
      const overview = await service.getOverview();
      res.status(200).json({ data: overview });
    },

    async updateWorkingCapital(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(updateWorkingCapitalSchema, req.body);
      const user = getAuthUser(res);
      const updated = await service.updateWorkingCapital(user.id, input.minWorkingCapital, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({
        data: { minWorkingCapital: updated },
        message: 'Pengaturan saldo modal belanja berhasil diperbarui.',
      });
    },

    async createTakeProfit(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(createTakeProfitSchema, req.body);
      const user = getAuthUser(res);
      const created = await service.recordTakeProfit(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(201).json({ data: created, message: 'Penarikan laba berhasil dicatat.' });
    },

    async listTakeProfits(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(listTakeProfitsQuerySchema, req.query);
      const result = await service.listTakeProfits(query);
      res.status(200).json({ data: result.data, pagination: result.pagination });
    },

    async deleteTakeProfit(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id, 'ID penarikan');
      const user = getAuthUser(res);
      await service.deleteTakeProfit(user.id, id, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ message: 'Catatan penarikan laba berhasil dihapus.' });
    },
  };
}
