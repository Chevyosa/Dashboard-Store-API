import type { Request, Response } from 'express';
import type { createAuditService } from '../services/audit.service.js';
import { AppError } from '../utils/errors.js';
import { listAuditLogsQuerySchema, parseOrThrow } from '../validators/audit.js';

export type AuditServiceInstance = ReturnType<typeof createAuditService>;

function parseId(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', 'ID audit tidak valid.');
  }
  return id;
}

export function createAuditController(service: AuditServiceInstance) {
  return {
    async list(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(listAuditLogsQuerySchema, req.query);
      const result = await service.listLogs(query);
      res.status(200).json({ data: result.data, pagination: result.pagination });
    },

    async getFilters(_req: Request, res: Response): Promise<void> {
      const filters = await service.getFilterOptions();
      res.status(200).json({ data: filters });
    },

    async getById(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const log = await service.getLogById(id);
      res.status(200).json({ data: log });
    },
  };
}
