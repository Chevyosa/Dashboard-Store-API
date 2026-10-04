import type { Pool } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import {
  StockReturnRepository,
  type StockReturnEntity,
  type CreateStockReturnData,
  type UpdateStockReturnData,
  type StockReturnFilterOptions,
} from '../repositories/stock-return.repository.js';
import { ProductRepository } from '../repositories/product.repository.js';
import { AppError } from '../utils/errors.js';
import { systemClock, type Clock } from '../utils/time.js';
import type {
  CreateStockReturnInput,
  UpdateStockReturnInput,
  ListStockReturnsQuery,
} from '../validators/stock-return.js';

export interface StockReturnServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export function createStockReturnService({ pool, clock = systemClock }: StockReturnServiceDeps) {
  const stockReturnRepo = new StockReturnRepository();
  const productRepo = new ProductRepository(pool);

  return {
    async createStockReturn(
      userId: number,
      input: CreateStockReturnInput,
      meta?: AuditMeta,
    ): Promise<StockReturnEntity> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const product = await productRepo.findById(input.productId, conn);
        if (!product) {
          throw new AppError(404, 'PRODUCT_NOT_FOUND', `Produk dengan ID ${input.productId} tidak ditemukan.`);
        }

        // Rule §5.7: Retur hanya boleh untuk produk titipan
        if (product.ownerType !== 'consignor') {
          throw new AppError(
            400,
            'INVALID_PRODUCT_TYPE',
            `Produk "${product.name}" adalah barang milik sendiri. Retur hanya berlaku untuk barang titipan (konsinyasi).`,
          );
        }

        const createData: CreateStockReturnData = {
          productId: input.productId,
          qtyPcs: input.qtyPcs,
          date: input.date,
          note: input.note ?? null,
        };

        const created = await stockReturnRepo.create(createData, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'stock_return.created',
          entityType: 'stock_return',
          entityId: String(created.id),
          after: created,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return created;
      });
    },

    async getStockReturnById(id: number): Promise<StockReturnEntity> {
      const stockReturn = await stockReturnRepo.findById(id, pool);
      if (!stockReturn) {
        throw new AppError(404, 'STOCK_RETURN_NOT_FOUND', `Data retur dengan ID ${id} tidak ditemukan.`);
      }
      return stockReturn;
    },

    async listStockReturns(query: ListStockReturnsQuery): Promise<{
      data: StockReturnEntity[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }> {
      const filterOptions: StockReturnFilterOptions = {
        page: query.page,
        limit: query.limit,
        productId: query.productId,
        consignorId: query.consignorId,
        period: query.period,
        startDate: query.startDate,
        endDate: query.endDate,
      };

      const { data, total } = await stockReturnRepo.list(filterOptions, pool);
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

    async updateStockReturn(
      userId: number,
      id: number,
      input: UpdateStockReturnInput,
      meta?: AuditMeta,
    ): Promise<StockReturnEntity> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await stockReturnRepo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'STOCK_RETURN_NOT_FOUND', `Data retur dengan ID ${id} tidak ditemukan.`);
        }

        // Rule §5.9: Locked if opname finalized
        if (existing.opnameId !== null) {
          throw new AppError(
            409,
            'PERIOD_CLOSED',
            'Data retur tidak dapat diubah karena periode opname sudah difinalisasi.',
          );
        }

        const updateData: UpdateStockReturnData = {
          ...(input.qtyPcs !== undefined ? { qtyPcs: input.qtyPcs } : {}),
          ...(input.date !== undefined ? { date: input.date } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        };

        const updated = await stockReturnRepo.update(id, updateData, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'stock_return.updated',
          entityType: 'stock_return',
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

    async deleteStockReturn(userId: number, id: number, meta?: AuditMeta): Promise<void> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await stockReturnRepo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'STOCK_RETURN_NOT_FOUND', `Data retur dengan ID ${id} tidak ditemukan.`);
        }

        // Rule §5.9: Locked if opname finalized
        if (existing.opnameId !== null) {
          throw new AppError(
            409,
            'PERIOD_CLOSED',
            'Data retur tidak dapat dihapus karena periode opname sudah difinalisasi.',
          );
        }

        await stockReturnRepo.delete(id, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'stock_return.deleted',
          entityType: 'stock_return',
          entityId: String(id),
          before: existing,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });
      });
    },
  };
}
