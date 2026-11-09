import type { Pool } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { getDefaultLossBorneBy } from '../domain/opname.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import {
  LossRepository,
  type LossEntity,
  type CreateLossData,
  type UpdateLossData,
  type LossFilterOptions,
  type LossSummary,
  type LossBorneBy,
} from '../repositories/loss.repository.js';
import { ProductRepository } from '../repositories/product.repository.js';
import { AppError } from '../utils/errors.js';
import { systemClock, type Clock } from '../utils/time.js';
import type {
  CreateLossInput,
  UpdateLossInput,
  ListLossesQuery,
} from '../validators/loss.js';

export interface LossServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export function createLossService({ pool, clock = systemClock }: LossServiceDeps) {
  const lossRepo = new LossRepository();
  const productRepo = new ProductRepository(pool);

  return {
    async createLoss(
      userId: number,
      input: CreateLossInput,
      meta?: AuditMeta,
    ): Promise<LossEntity> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const product = await productRepo.findById(input.productId, conn);
        if (!product) {
          throw new AppError(404, 'PRODUCT_NOT_FOUND', `Produk dengan ID ${input.productId} tidak ditemukan.`);
        }

        let borneBy: LossBorneBy;

        // Rule §5.6: Produk own SELALU ditanggung owner (dikunci)
        if (product.ownerType === 'own') {
          if (input.borneBy && input.borneBy !== 'owner') {
            throw new AppError(
              400,
              'INVALID_BORNE_BY',
              `Produk "${product.name}" adalah barang milik sendiri. Kerugian harus ditanggung oleh Owner.`,
            );
          }
          borneBy = 'owner';
        } else {
          // Produk titipan: gunakan input jika disediakan, jika tidak gunakan default tabel §5.6
          borneBy = input.borneBy ?? getDefaultLossBorneBy('consignor', input.reason);
        }

        const createData: CreateLossData = {
          productId: input.productId,
          qtyPcs: input.qtyPcs,
          reason: input.reason,
          borneBy,
          date: input.date,
          note: input.note ?? null,
        };

        const created = await lossRepo.create(createData, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'loss.created',
          entityType: 'loss',
          entityId: String(created.id),
          after: created,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return created;
      });
    },

    async getLossById(id: number): Promise<LossEntity> {
      const loss = await lossRepo.findById(id, pool);
      if (!loss) {
        throw new AppError(404, 'LOSS_NOT_FOUND', `Data loss dengan ID ${id} tidak ditemukan.`);
      }
      return loss;
    },

    async listLosses(query: ListLossesQuery): Promise<{
      data: LossEntity[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }> {
      const filterOptions: LossFilterOptions = {
        page: query.page,
        limit: query.limit,
        period: query.period,
        reason: query.reason,
        borneBy: query.borneBy,
        productId: query.productId,
        startDate: query.startDate,
        endDate: query.endDate,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      };

      const { data, total } = await lossRepo.list(filterOptions, pool);
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

    async updateLoss(
      userId: number,
      id: number,
      input: UpdateLossInput,
      meta?: AuditMeta,
    ): Promise<LossEntity> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await lossRepo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'LOSS_NOT_FOUND', `Data loss dengan ID ${id} tidak ditemukan.`);
        }

        // Rule §5.9: Record yang sudah masuk ke opname final tidak boleh diedit (sebelum T-13)
        if (existing.opnameId !== null) {
          throw new AppError(
            409,
            'PERIOD_CLOSED',
            `Data loss pada periode yang sudah final (Opname #${existing.opnameId}) tidak dapat diubah.`,
          );
        }

        const targetProductId = input.productId ?? existing.productId;
        const targetProduct = input.productId
          ? await productRepo.findById(input.productId, conn)
          : await productRepo.findById(existing.productId, conn);

        if (!targetProduct) {
          throw new AppError(404, 'PRODUCT_NOT_FOUND', `Produk dengan ID ${targetProductId} tidak ditemukan.`);
        }

        // Validasi borne_by
        let borneBy = input.borneBy ?? existing.borneBy;
        if (targetProduct.ownerType === 'own') {
          if (borneBy !== 'owner') {
            throw new AppError(
              400,
              'INVALID_BORNE_BY',
              `Produk "${targetProduct.name}" adalah barang milik sendiri. Kerugian harus ditanggung oleh Owner.`,
            );
          }
          borneBy = 'owner';
        }

        const updateData: UpdateLossData = {
          productId: input.productId,
          qtyPcs: input.qtyPcs,
          reason: input.reason,
          borneBy: input.borneBy !== undefined ? borneBy : undefined,
          date: input.date,
          note: input.note,
        };

        const updated = await lossRepo.update(id, updateData, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'loss.updated',
          entityType: 'loss',
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

    async deleteLoss(userId: number, id: number, meta?: AuditMeta): Promise<void> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await lossRepo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'LOSS_NOT_FOUND', `Data loss dengan ID ${id} tidak ditemukan.`);
        }

        // Rule §5.9: Record yang sudah masuk ke opname final tidak boleh dihapus
        if (existing.opnameId !== null) {
          throw new AppError(
            409,
            'PERIOD_CLOSED',
            `Data loss pada periode yang sudah final (Opname #${existing.opnameId}) tidak dapat dihapus.`,
          );
        }

        await lossRepo.delete(id, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'loss.deleted',
          entityType: 'loss',
          entityId: String(id),
          before: existing,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });
      });
    },

    async getOpenPeriodSummary(): Promise<LossSummary> {
      return lossRepo.getOpenPeriodSummary(pool);
    },
  };
}
