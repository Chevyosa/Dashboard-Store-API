import type { Pool } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import {
  ProductRepository,
  type ProductEntity,
  type CreateProductData,
  type UpdateProductData,
  type ProductQueryOptions,
} from '../repositories/product.repository.js';
import { findConsignorById } from '../repositories/consignor.repository.js';
import { calculateConsignorMargin, calculateOwnMargin } from '../domain/margin.js';
import { toDbString, mulMoney } from '../domain/money.js';
import { AppError } from '../utils/errors.js';
import { systemClock, type Clock } from '../utils/time.js';
import type {
  CreateProductInput,
  UpdateProductInput,
  PreviewMarginInput,
} from '../validators/product.js';

export interface ProductServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface ProductMarginInfo {
  ownerMarginPerPcs: string | null;
  ownerMarginPerPack: string | null;
  consignorSharePerPcs: string | null;
  consignorSharePerPack: string | null;
}

export interface ProductWithMargin extends ProductEntity {
  marginInfo: ProductMarginInfo;
}

export function computeMarginForProduct(product: ProductEntity): ProductMarginInfo {
  if (product.ownerType === 'consignor' && product.marginType && product.marginValue) {
    const marginRes = calculateConsignorMargin(
      product.sellPrice,
      product.marginType === 'nominal'
        ? { type: 'nominal', marginValue: product.marginValue }
        : { type: 'percent', marginPercentage: product.marginValue },
    );

    const ownerMarginPerPcs = toDbString(marginRes.ownerMarginPerPcs);
    const consignorSharePerPcs = toDbString(marginRes.consignorSharePerPcs);
    const ownerMarginPerPack = toDbString(
      mulMoney(marginRes.ownerMarginPerPcs, product.pcsPerPack.toString()),
    );
    const consignorSharePerPack = toDbString(
      mulMoney(marginRes.consignorSharePerPcs, product.pcsPerPack.toString()),
    );

    return {
      ownerMarginPerPcs,
      ownerMarginPerPack,
      consignorSharePerPcs,
      consignorSharePerPack,
    };
  }

  // Untuk produk own, modal dihitung per opname; saat belum ada avg_cost tampilkan null
  return {
    ownerMarginPerPcs: null,
    ownerMarginPerPack: null,
    consignorSharePerPcs: null,
    consignorSharePerPack: null,
  };
}

export function createProductService(deps: ProductServiceDeps) {
  const { pool, clock = systemClock } = deps;
  const productRepo = new ProductRepository(pool);

  return {
    previewMargin(input: PreviewMarginInput): ProductMarginInfo {
      if (input.ownerType === 'consignor' && input.marginType && input.marginValue) {
        const marginRes = calculateConsignorMargin(
          input.sellPrice,
          input.marginType === 'nominal'
            ? { type: 'nominal', marginValue: input.marginValue }
            : { type: 'percent', marginPercentage: input.marginValue },
        );

        const ownerMarginPerPcs = toDbString(marginRes.ownerMarginPerPcs);
        const consignorSharePerPcs = toDbString(marginRes.consignorSharePerPcs);
        const ownerMarginPerPack = toDbString(
          mulMoney(marginRes.ownerMarginPerPcs, input.pcsPerPack.toString()),
        );
        const consignorSharePerPack = toDbString(
          mulMoney(marginRes.consignorSharePerPcs, input.pcsPerPack.toString()),
        );

        return {
          ownerMarginPerPcs,
          ownerMarginPerPack,
          consignorSharePerPcs,
          consignorSharePerPack,
        };
      }

      if (input.ownerType === 'own' && input.avgCost) {
        const ownRes = calculateOwnMargin(input.sellPrice, input.avgCost, input.pcsPerPack);
        return {
          ownerMarginPerPcs: toDbString(ownRes.marginPerPcs),
          ownerMarginPerPack: toDbString(ownRes.marginPerPack),
          consignorSharePerPcs: null,
          consignorSharePerPack: null,
        };
      }

      return {
        ownerMarginPerPcs: null,
        ownerMarginPerPack: null,
        consignorSharePerPcs: null,
        consignorSharePerPack: null,
      };
    },

    async createProduct(
      userId: number,
      input: CreateProductInput,
      meta?: AuditMeta,
    ): Promise<ProductWithMargin> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        // 1. Cek duplikasi nama (case-insensitive)
        const existing = await productRepo.findByName(input.name, conn);
        if (existing !== null) {
          throw new AppError(409, 'PRODUCT_NAME_EXISTS', `Produk "${input.name}" sudah terdaftar.`);
        }

        // 2. Jika titipan, pastikan penitip ada dan aktif
        if (input.ownerType === 'consignor') {
          const consignor = await findConsignorById(conn, input.consignorId!);
          if (!consignor) {
            throw new AppError(404, 'CONSIGNOR_NOT_FOUND', 'Penitip yang dipilih tidak ditemukan.');
          }
          if (!consignor.isActive) {
            throw new AppError(
              409,
              'CONSIGNOR_INACTIVE',
              `Penitip "${consignor.name}" sedang nonaktif. Aktifkan penitip terlebih dahulu.`,
            );
          }
        }

        const data: CreateProductData = {
          name: input.name,
          ownerType: input.ownerType,
          consignorId: input.ownerType === 'consignor' ? input.consignorId! : null,
          pcsPerPack: input.pcsPerPack,
          sellPrice: input.sellPrice,
          marginType: input.ownerType === 'consignor' ? input.marginType! : null,
          marginValue: input.ownerType === 'consignor' ? input.marginValue! : null,
        };

        const created = await productRepo.create(data, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'product.created',
          entityType: 'product',
          entityId: String(created.id),
          after: created,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return {
          ...created,
          marginInfo: computeMarginForProduct(created),
        };
      });
    },

    async getProductById(id: number): Promise<ProductWithMargin> {
      const product = await productRepo.findById(id);
      if (!product) {
        throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan.');
      }
      return {
        ...product,
        marginInfo: computeMarginForProduct(product),
      };
    },

    async listProducts(
      params: ProductQueryOptions,
    ): Promise<{
      data: ProductWithMargin[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
    }> {
      const { data, total } = await productRepo.findAll(params);
      const totalPages = Math.ceil(total / params.limit) || 1;

      return {
        data: data.map((p) => ({
          ...p,
          marginInfo: computeMarginForProduct(p),
        })),
        pagination: {
          page: params.page,
          limit: params.limit,
          total,
          totalPages,
        },
      };
    },

    async updateProduct(
      userId: number,
      id: number,
      input: UpdateProductInput,
      meta?: AuditMeta,
    ): Promise<ProductWithMargin> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await productRepo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan.');
        }

        // Cek duplikasi nama jika nama diubah
        if (existing.name.toLowerCase() !== input.name.toLowerCase()) {
          const duplicate = await productRepo.findByName(input.name, conn);
          if (duplicate && duplicate.id !== id) {
            throw new AppError(
              409,
              'PRODUCT_NAME_EXISTS',
              `Produk dengan nama "${input.name}" sudah terdaftar.`,
            );
          }
        }

        // Jika titipan, pastikan penitip ada dan aktif
        if (input.ownerType === 'consignor') {
          const consignor = await findConsignorById(conn, input.consignorId!);
          if (!consignor) {
            throw new AppError(404, 'CONSIGNOR_NOT_FOUND', 'Penitip yang dipilih tidak ditemukan.');
          }
          if (!consignor.isActive && existing.consignorId !== input.consignorId) {
            throw new AppError(
              409,
              'CONSIGNOR_INACTIVE',
              `Penitip "${consignor.name}" sedang nonaktif.`,
            );
          }
        }

        const data: UpdateProductData = {
          name: input.name,
          ownerType: input.ownerType,
          consignorId: input.ownerType === 'consignor' ? input.consignorId! : null,
          pcsPerPack: input.pcsPerPack,
          sellPrice: input.sellPrice,
          marginType: input.ownerType === 'consignor' ? input.marginType! : null,
          marginValue: input.ownerType === 'consignor' ? input.marginValue! : null,
        };

        const updated = await productRepo.update(id, data, conn);
        if (!updated) {
          throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan saat memperbarui.');
        }

        await insertAuditEntry(conn, {
          userId,
          action: 'product.updated',
          entityType: 'product',
          entityId: String(id),
          before: existing,
          after: updated,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return {
          ...updated,
          marginInfo: computeMarginForProduct(updated),
        };
      });
    },

    async setProductStatus(
      userId: number,
      id: number,
      isActive: boolean,
      meta?: AuditMeta,
    ): Promise<ProductWithMargin> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await productRepo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan.');
        }

        if (existing.isActive === isActive) {
          return {
            ...existing,
            marginInfo: computeMarginForProduct(existing),
          };
        }

        const updated = await productRepo.setStatus(id, isActive, conn);
        if (!updated) {
          throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Gagal memperbarui status produk.');
        }

        await insertAuditEntry(conn, {
          userId,
          action: 'product.status_changed',
          entityType: 'product',
          entityId: String(id),
          before: existing,
          after: updated,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return {
          ...updated,
          marginInfo: computeMarginForProduct(updated),
        };
      });
    },
  };
}
