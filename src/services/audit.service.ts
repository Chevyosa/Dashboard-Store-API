import type { Pool } from 'mysql2/promise';
import {
  findAuditLogById,
  getDistinctFilterValues,
  listAuditLogs,
  type AuditLogEntity,
} from '../repositories/audit.repository.js';
import { AppError } from '../utils/errors.js';
import type { ListAuditLogsQuery } from '../validators/audit.js';

export interface AuditServiceDeps {
  pool: Pool;
}

export function createAuditService(deps: AuditServiceDeps) {
  const { pool } = deps;

  return {
    async listLogs(query: ListAuditLogsQuery): Promise<{
      data: AuditLogEntity[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }> {
      const { data, total } = await listAuditLogs(
        {
          page: query.page,
          limit: query.limit,
          action: query.action,
          entityType: query.entityType,
          entityId: query.entityId,
          userId: query.userId,
          startDate: query.startDate,
          endDate: query.endDate,
          search: query.search,
        },
        pool,
      );

      const totalPages = Math.ceil(total / query.limit) || 1;

      return {
        data,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages,
        },
      };
    },

    async getLogById(id: number): Promise<AuditLogEntity> {
      const log = await findAuditLogById(id, pool);
      if (!log) {
        throw new AppError(404, 'AUDIT_LOG_NOT_FOUND', `Catatan audit dengan ID ${id} tidak ditemukan.`);
      }
      return log;
    },

    async getFilterOptions(): Promise<{ actions: string[]; entityTypes: string[] }> {
      return getDistinctFilterValues(pool);
    },
  };
}
