import type { Pool } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import {
  findConsignorById,
  findConsignorByName,
  insertConsignor,
  listConsignors,
  setConsignorStatus,
  updateConsignor,
  type ConsignorRecord,
  type ListConsignorsParams,
} from '../repositories/consignor.repository.js';
import { AppError } from '../utils/errors.js';
import { systemClock, type Clock } from '../utils/time.js';

export interface ConsignorServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface CreateConsignorDto {
  name: string;
  phone?: string | null | undefined;
  note?: string | null | undefined;
  defaultMarginType?: 'nominal' | 'percent' | null | undefined;
  defaultMarginValue?: string | null | undefined;
}

export interface UpdateConsignorDto {
  name?: string | undefined;
  phone?: string | null | undefined;
  note?: string | null | undefined;
  defaultMarginType?: 'nominal' | 'percent' | null | undefined;
  defaultMarginValue?: string | null | undefined;
}

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export function createConsignorService(deps: ConsignorServiceDeps) {
  const { pool, clock = systemClock } = deps;

  return {
    async createConsignor(
      userId: number,
      input: CreateConsignorDto,
      meta?: AuditMeta,
    ): Promise<ConsignorRecord> {
      const now = clock();
      return withTransaction(pool, async (conn) => {
        const existing = await findConsignorByName(conn, input.name);
        if (existing !== null) {
          throw new AppError(409, 'CONSIGNOR_NAME_EXISTS', 'Nama penitip sudah terdaftar.');
        }

        const id = await insertConsignor(conn, {
          name: input.name,
          phone: input.phone,
          note: input.note,
          defaultMarginType: input.defaultMarginType,
          defaultMarginValue: input.defaultMarginValue,
          now,
        });

        const created = (await findConsignorById(conn, id))!;

        await insertAuditEntry(conn, {
          userId,
          action: 'consignor.created',
          entityType: 'consignor',
          entityId: String(id),
          after: created,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return created;
      });
    },

    async getConsignorById(id: number): Promise<ConsignorRecord> {
      const consignor = await findConsignorById(pool, id);
      if (consignor === null) {
        throw new AppError(404, 'CONSIGNOR_NOT_FOUND', 'Penitip tidak ditemukan.');
      }
      return consignor;
    },

    async listConsignors(
      params: ListConsignorsParams,
    ): Promise<{ consignors: ConsignorRecord[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
      const { consignors, total } = await listConsignors(pool, params);
      const totalPages = Math.ceil(total / params.limit) || 1;

      return {
        consignors,
        pagination: {
          page: params.page,
          limit: params.limit,
          total,
          totalPages,
        },
      };
    },

    async updateConsignor(
      userId: number,
      id: number,
      input: UpdateConsignorDto,
      meta?: AuditMeta,
    ): Promise<ConsignorRecord> {
      const now = clock();
      return withTransaction(pool, async (conn) => {
        const existing = await findConsignorById(conn, id);
        if (existing === null) {
          throw new AppError(404, 'CONSIGNOR_NOT_FOUND', 'Penitip tidak ditemukan.');
        }

        if (input.name !== undefined && input.name.toLowerCase() !== existing.name.toLowerCase()) {
          const duplicate = await findConsignorByName(conn, input.name);
          if (duplicate !== null && duplicate.id !== id) {
            throw new AppError(409, 'CONSIGNOR_NAME_EXISTS', 'Nama penitip sudah terdaftar.');
          }
        }

        const updated = (await updateConsignor(conn, id, {
          name: input.name,
          phone: input.phone,
          note: input.note,
          defaultMarginType: input.defaultMarginType,
          defaultMarginValue: input.defaultMarginValue,
          now,
        }))!;

        await insertAuditEntry(conn, {
          userId,
          action: 'consignor.updated',
          entityType: 'consignor',
          entityId: String(id),
          before: existing,
          after: updated,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return updated;
      });
    },

    async setConsignorStatus(
      userId: number,
      id: number,
      isActive: boolean,
      meta?: AuditMeta,
    ): Promise<ConsignorRecord> {
      const now = clock();
      return withTransaction(pool, async (conn) => {
        const existing = await findConsignorById(conn, id);
        if (existing === null) {
          throw new AppError(404, 'CONSIGNOR_NOT_FOUND', 'Penitip tidak ditemukan.');
        }

        if (existing.isActive === isActive) {
          return existing;
        }

        const updated = (await setConsignorStatus(conn, id, isActive, now))!;

        await insertAuditEntry(conn, {
          userId,
          action: 'consignor.status_changed',
          entityType: 'consignor',
          entityId: String(id),
          before: { isActive: existing.isActive },
          after: { isActive },
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return updated;
      });
    },
  };
}

export type ConsignorService = ReturnType<typeof createConsignorService>;
