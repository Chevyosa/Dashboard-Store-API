import type { Pool } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import {
  StockInRepository,
  type StockInEntity,
  type CreateStockInLineData,
  type CreateStockInData,
  type UpdateStockInData,
  type StockInFilterOptions,
  type StockInSummary,
} from '../repositories/stock-in.repository.js';
import { ProductRepository } from '../repositories/product.repository.js';
import { parseMoney, toDbString } from '../domain/money.js';
import { AppError } from '../utils/errors.js';
import { systemClock, type Clock } from '../utils/time.js';
import type {
  CreateStockInInput,
  UpdateStockInInput,
  ListStockInsQuery,
} from '../validators/stock-in.js';

export interface StockInServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export function createStockInService({ pool, clock = systemClock }: StockInServiceDeps) {
  const stockInRepo = new StockInRepository();
  const productRepo = new ProductRepository(pool);

  return {
    async createStockIn(
      userId: number,
      input: CreateStockInInput,
      meta?: AuditMeta,
    ): Promise<StockInEntity> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const processedLines: CreateStockInLineData[] = [];

        for (const line of input.lines) {
          const product = await productRepo.findById(line.productId, conn);
          if (!product) {
            throw new AppError(404, 'PRODUCT_NOT_FOUND', `Produk dengan ID ${line.productId} tidak ditemukan.`);
          }

          // Rule §5.3: Type vs Owner Type compatibility
          if (input.type === 'purchase' && product.ownerType === 'consignor') {
            throw new AppError(
              400,
              'INVALID_PRODUCT_TYPE',
              `Produk "${product.name}" adalah barang titipan. Transaksi belanja own (purchase) hanya untuk produk milik sendiri.`,
            );
          }

          if (input.type === 'consignment_in' && product.ownerType === 'own') {
            throw new AppError(
              400,
              'INVALID_PRODUCT_TYPE',
              `Produk "${product.name}" adalah barang milik sendiri. Transaksi setoran penitip (consignment_in) hanya untuk produk titipan.`,
            );
          }

          // Rule §5.3: Consignor products always have 0 cost
          let lineCost = '0.0000';
          if (product.ownerType === 'own') {
            const costDec = parseMoney(line.totalCost || '0');
            if (costDec.isNegative()) {
              throw new AppError(400, 'INVALID_COST', 'Total biaya belanja tidak boleh negatif.');
            }
            lineCost = toDbString(costDec);
          }

          // Pack vs Pcs
          const pcsPerPack = product.pcsPerPack > 0 ? product.pcsPerPack : 1;
          const qtyPack = line.inputMode === 'pack' ? (line.qtyPack ?? 1) : null;
          const qtyPcs = line.inputMode === 'pack' ? qtyPack! * pcsPerPack : (line.qtyPcs ?? 1);

          processedLines.push({
            productId: product.id,
            inputMode: line.inputMode,
            qtyPack,
            pcsPerPackSnapshot: pcsPerPack,
            qtyPcs,
            totalCost: lineCost,
          });
        }

        const createData: CreateStockInData = {
          type: input.type,
          date: input.date,
          note: input.note ?? null,
          lines: processedLines,
        };

        const created = await stockInRepo.create(createData, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'stock_in.created',
          entityType: 'stock_in',
          entityId: String(created.id),
          after: created,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return created;
      });
    },

    async getStockInById(id: number): Promise<StockInEntity> {
      const stockIn = await stockInRepo.findById(id, pool);
      if (!stockIn) {
        throw new AppError(404, 'STOCK_IN_NOT_FOUND', `Data barang masuk dengan ID ${id} tidak ditemukan.`);
      }
      return stockIn;
    },

    async listStockIns(query: ListStockInsQuery): Promise<{
      data: StockInEntity[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }> {
      const filterOptions: StockInFilterOptions = {
        page: query.page,
        limit: query.limit,
        type: query.type,
        period: query.period,
        startDate: query.startDate,
        endDate: query.endDate,
      };

      const { data, total } = await stockInRepo.list(filterOptions, pool);
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

    async updateStockIn(
      userId: number,
      id: number,
      input: UpdateStockInInput,
      meta?: AuditMeta,
    ): Promise<StockInEntity> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await stockInRepo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'STOCK_IN_NOT_FOUND', `Data barang masuk dengan ID ${id} tidak ditemukan.`);
        }

        // Rule §5.9: Locked if opname finalized
        if (existing.opnameId !== null) {
          throw new AppError(
            409,
            'PERIOD_CLOSED',
            'Data barang masuk tidak dapat diubah karena periode opname sudah difinalisasi.',
          );
        }

        let processedLines: CreateStockInLineData[] | undefined = undefined;

        if (input.lines) {
          processedLines = [];
          for (const line of input.lines) {
            const product = await productRepo.findById(line.productId, conn);
            if (!product) {
              throw new AppError(404, 'PRODUCT_NOT_FOUND', `Produk dengan ID ${line.productId} tidak ditemukan.`);
            }

            if (existing.type === 'purchase' && product.ownerType === 'consignor') {
              throw new AppError(
                400,
                'INVALID_PRODUCT_TYPE',
                `Produk "${product.name}" adalah barang titipan. Transaksi belanja own hanya untuk produk milik sendiri.`,
              );
            }

            if (existing.type === 'consignment_in' && product.ownerType === 'own') {
              throw new AppError(
                400,
                'INVALID_PRODUCT_TYPE',
                `Produk "${product.name}" adalah barang milik sendiri. Transaksi setoran penitip hanya untuk produk titipan.`,
              );
            }

            let lineCost = '0.0000';
            if (product.ownerType === 'own') {
              const costDec = parseMoney(line.totalCost || '0');
              if (costDec.isNegative()) {
                throw new AppError(400, 'INVALID_COST', 'Total biaya belanja tidak boleh negatif.');
              }
              lineCost = toDbString(costDec);
            }

            const pcsPerPack = product.pcsPerPack > 0 ? product.pcsPerPack : 1;
            const qtyPack = line.inputMode === 'pack' ? (line.qtyPack ?? 1) : null;
            const qtyPcs = line.inputMode === 'pack' ? qtyPack! * pcsPerPack : (line.qtyPcs ?? 1);

            processedLines.push({
              productId: product.id,
              inputMode: line.inputMode,
              qtyPack,
              pcsPerPackSnapshot: pcsPerPack,
              qtyPcs,
              totalCost: lineCost,
            });
          }
        }

        const updateData: UpdateStockInData = {
          ...(input.date !== undefined ? { date: input.date } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(processedLines !== undefined ? { lines: processedLines } : {}),
        };

        const updated = await stockInRepo.update(id, updateData, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'stock_in.updated',
          entityType: 'stock_in',
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

    async deleteStockIn(userId: number, id: number, meta?: AuditMeta): Promise<void> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await stockInRepo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'STOCK_IN_NOT_FOUND', `Data barang masuk dengan ID ${id} tidak ditemukan.`);
        }

        // Rule §5.9: Locked if opname finalized
        if (existing.opnameId !== null) {
          throw new AppError(
            409,
            'PERIOD_CLOSED',
            'Data barang masuk tidak dapat dihapus karena periode opname sudah difinalisasi.',
          );
        }

        await stockInRepo.delete(id, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'stock_in.deleted',
          entityType: 'stock_in',
          entityId: String(id),
          before: existing,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });
      });
    },

    async getOpenPeriodSummary(): Promise<StockInSummary> {
      return stockInRepo.getOpenPeriodSummary(pool);
    },
  };
}
