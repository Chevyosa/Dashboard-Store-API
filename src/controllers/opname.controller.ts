import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { createOpnameService } from '../services/opname.service.js';
import { AppError } from '../utils/errors.js';
import {
  prepareOpnameQuerySchema,
  calculateOpnameSchema,
  saveDraftOpnameSchema,
  finalizeOpnameSchema,
  listOpnamesQuerySchema,
  parseOrThrow,
} from '../validators/opname.js';

export type OpnameServiceInstance = ReturnType<typeof createOpnameService>;

function parseId(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', 'ID opname tidak valid.');
  }
  return id;
}

export function createOpnameController(service: OpnameServiceInstance) {
  return {
    async prepare(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(prepareOpnameQuerySchema, req.query);
      const sheet = await service.prepareOpnameSheet(query.date);
      res.status(200).json({ data: sheet });
    },

    async calculate(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(calculateOpnameSchema, req.body);
      const result = await service.calculateDraft(input.opnameDate, input.items);
      res.status(200).json({ data: result });
    },

    async saveDraft(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(saveDraftOpnameSchema, req.body);
      const user = getAuthUser(res);
      const opname = await service.saveDraft(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ data: opname });
    },

    async finalize(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(finalizeOpnameSchema, req.body);
      const user = getAuthUser(res);
      const opname = await service.finalizeOpname(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(201).json({ data: opname });
    },

    async list(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(listOpnamesQuerySchema, req.query);
      const result = await service.listOpnames(query);
      res.status(200).json({ data: result.data, pagination: result.pagination });
    },

    async getById(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const opname = await service.getOpnameById(id);
      res.status(200).json({ data: opname });
    },

    async deleteDraft(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const user = getAuthUser(res);
      await service.deleteDraft(user.id, id, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ message: 'Draft opname berhasil dihapus.' });
    },
  };
}
