import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { createStockInService } from '../services/stock-in.service.js';
import { AppError } from '../utils/errors.js';
import {
  createStockInSchema,
  updateStockInSchema,
  listStockInsQuerySchema,
  parseOrThrow,
} from '../validators/stock-in.js';

export type StockInServiceInstance = ReturnType<typeof createStockInService>;

function parseId(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', 'ID barang masuk tidak valid.');
  }
  return id;
}

export function createStockInController(service: StockInServiceInstance) {
  return {
    async create(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(createStockInSchema, req.body);
      const user = getAuthUser(res);
      const stockIn = await service.createStockIn(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(201).json({ data: stockIn });
    },

    async list(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(listStockInsQuerySchema, req.query);
      const result = await service.listStockIns(query);
      res.status(200).json({ data: result.data, pagination: result.pagination });
    },

    async getById(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const stockIn = await service.getStockInById(id);
      res.status(200).json({ data: stockIn });
    },

    async update(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const input = parseOrThrow(updateStockInSchema, req.body);
      const user = getAuthUser(res);
      const stockIn = await service.updateStockIn(user.id, id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ data: stockIn });
    },

    async delete(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const user = getAuthUser(res);
      await service.deleteStockIn(user.id, id, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ message: 'Data barang masuk berhasil dihapus.' });
    },

    async getOpenPeriodSummary(_req: Request, res: Response): Promise<void> {
      const summary = await service.getOpenPeriodSummary();
      res.status(200).json({ data: summary });
    },
  };
}
