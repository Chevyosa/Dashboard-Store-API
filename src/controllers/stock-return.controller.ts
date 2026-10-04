import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { createStockReturnService } from '../services/stock-return.service.js';
import { AppError } from '../utils/errors.js';
import {
  createStockReturnSchema,
  updateStockReturnSchema,
  listStockReturnsQuerySchema,
  parseOrThrow,
} from '../validators/stock-return.js';

export type StockReturnServiceInstance = ReturnType<typeof createStockReturnService>;

function parseId(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', 'ID retur tidak valid.');
  }
  return id;
}

export function createStockReturnController(service: StockReturnServiceInstance) {
  return {
    async create(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(createStockReturnSchema, req.body);
      const user = getAuthUser(res);
      const stockReturn = await service.createStockReturn(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(201).json({ data: stockReturn });
    },

    async list(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(listStockReturnsQuerySchema, req.query);
      const result = await service.listStockReturns(query);
      res.status(200).json({ data: result.data, pagination: result.pagination });
    },

    async getById(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const stockReturn = await service.getStockReturnById(id);
      res.status(200).json({ data: stockReturn });
    },

    async update(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const input = parseOrThrow(updateStockReturnSchema, req.body);
      const user = getAuthUser(res);
      const stockReturn = await service.updateStockReturn(user.id, id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ data: stockReturn });
    },

    async delete(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const user = getAuthUser(res);
      await service.deleteStockReturn(user.id, id, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ message: 'Data retur berhasil dihapus.' });
    },
  };
}
