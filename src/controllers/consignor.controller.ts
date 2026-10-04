import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { ConsignorService } from '../services/consignor.service.js';
import { AppError } from '../utils/errors.js';
import {
  createConsignorSchema,
  listConsignorsQuerySchema,
  parseOrThrow,
  toggleConsignorStatusSchema,
  updateConsignorSchema,
} from '../validators/consignor.js';

function parseId(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', 'ID penitip tidak valid.');
  }
  return id;
}

export function createConsignorController(service: ConsignorService) {
  return {
    async create(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(createConsignorSchema, req.body);
      const user = getAuthUser(res);
      const consignor = await service.createConsignor(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(201).json({ data: consignor });
    },

    async list(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(listConsignorsQuerySchema, req.query);
      const result = await service.listConsignors(query);
      res.status(200).json({ data: result.consignors, pagination: result.pagination });
    },

    async getById(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const consignor = await service.getConsignorById(id);
      res.status(200).json({ data: consignor });
    },

    async update(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const input = parseOrThrow(updateConsignorSchema, req.body);
      const user = getAuthUser(res);
      const consignor = await service.updateConsignor(user.id, id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ data: consignor });
    },

    async setStatus(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const input = parseOrThrow(toggleConsignorStatusSchema, req.body);
      const user = getAuthUser(res);
      const consignor = await service.setConsignorStatus(user.id, id, input.isActive, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ data: consignor });
    },
  };
}

export type ConsignorController = ReturnType<typeof createConsignorController>;
