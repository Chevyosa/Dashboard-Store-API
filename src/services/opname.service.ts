import type { Pool, PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import {
  toDbString,
  addMoney,
  ZERO_MONEY,
} from '../domain/money.js';
import {
  calculateOpnameProduct,
  type OpnameProductInput,
  type OpnameProductResult,
  type LossItem,
} from '../domain/opname.js';
import { calculateConsignorPayouts } from '../domain/payout.js';
import { calculateReconciliation, type ReconciliationResult } from '../domain/profit.js';
import {
  DomainError,
  NegativeDiffStockError,
  LossExceedsDiffStockError,
} from '../domain/errors.js';
import {
  OpnameRepository,
  type OpnameEntity,
  type OpnameItemEntity,
  type OpnameFilterOptions,
  type Db,
} from '../repositories/opname.repository.js';
import { ProductRepository, type ProductEntity } from '../repositories/product.repository.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import { AppError } from '../utils/errors.js';
import { systemClock, type Clock } from '../utils/time.js';
import type {
  PhysicalItemInput,
  SaveDraftOpnameInput,
  FinalizeOpnameInput,
  ListOpnamesQuery,
} from '../validators/opname.js';

export interface OpnameServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface OpnameTotals {
  totalTurnover: string;
  totalSoldQty: number;
  totalLossQty: number;
  totalCogs: string;
  totalPayoutDue: string;
  cashAmount: string;
  qrisAmount: string;
  realCash: string;
  cashDifference: string;
  profitA: string;
  profitB: string;
}

export interface PreparedSheetProduct {
  productId: number;
  productName: string;
  ownerType: 'own' | 'consignor';
  consignorId: number | null;
  consignorName: string | null;
  pcsPerPack: number;
  sellPrice: string;
  marginType: 'nominal' | 'percent' | null;
  marginValue: string | null;
  openingQty: number;
  openingValue: string;
  inQty: number;
  inCost: string;
  returnedQty: number;
  expectedQty: number;
  lossQty: number;
  losses: LossItem[];
  draftPhysicalQty: number | null;
}

export function createOpnameService({ pool, clock = systemClock }: OpnameServiceDeps) {
  const opnameRepo = new OpnameRepository();
  const productRepo = new ProductRepository(pool);

  async function computeOpnameData(
    opnameDate: string,
    items: PhysicalItemInput[],
    cashAmountStr = '0',
    qrisAmountStr = '0',
    existingOpnameId: number | null = null,
    db: Db = pool,
  ): Promise<{
    calculatedItems: Omit<OpnameItemEntity, 'id' | 'opnameId' | 'createdAt' | 'updatedAt'>[];
    calculatedPayouts: { consignorId: number; soldShare: string; lossCompensation: string; payoutDue: string }[];
    totals: OpnameTotals;
    reconciliation: {
      theoreticalTurnover: string;
      realCash: string;
      cashDifference: string;
      cashDifferenceHint: string;
      profitA: string;
      profitB: string;
      profitDiff: string;
      invariantI3Satisfied: boolean;
    };
  }> {
    const prevClosing = await opnameRepo.findPreviousOpname(opnameDate, db);
    const openMovements = await opnameRepo.findOpenMovements(opnameDate, db);

    const calculatedResults: OpnameProductResult[] = [];
    const dbItems: Omit<OpnameItemEntity, 'id' | 'opnameId' | 'createdAt' | 'updatedAt'>[] = [];

    for (const item of items) {
      const conn = db && 'release' in db ? (db as PoolConnection) : undefined;
      const product = await productRepo.findById(item.productId, conn);
      if (!product) {
        throw new AppError(404, 'PRODUCT_NOT_FOUND', `Produk dengan ID ${item.productId} tidak ditemukan.`);
      }

      const prev = prevClosing.get(product.id);
      const openingQty = prev?.closingQty ?? 0;
      const openingValue = prev?.closingValue ?? '0.0000';

      const mov = openMovements.get(product.id);
      const inQty = mov?.inQty ?? 0;
      const inCost = mov?.inCost ?? '0.0000';
      const returnedQty = mov?.returnedQty ?? 0;
      const losses = (mov?.losses ?? []) as LossItem[];

      const domainInput: OpnameProductInput = {
        productId: String(product.id),
        productName: product.name,
        ownerType: product.ownerType,
        consignorId: product.consignorId !== null ? String(product.consignorId) : null,
        openingQty,
        inQty,
        returnedQty,
        physicalQty: item.physicalQty,
        losses,
        sellPrice: product.sellPrice,
        openingValue,
        inCost,
        pcsPerPack: product.pcsPerPack,
      };

      if (product.ownerType === 'consignor') {
        if (product.marginType === 'nominal' && product.marginValue !== null) {
          domainInput.marginScheme = {
            type: 'nominal',
            marginValue: product.marginValue,
          };
        } else if (product.marginType === 'percent' && product.marginValue !== null) {
          domainInput.marginScheme = {
            type: 'percent',
            marginPercentage: product.marginValue,
          };
        } else {
          throw new AppError(
            400,
            'INVALID_MARGIN_SCHEME',
            `Produk titipan "${product.name}" belum memiliki skema margin yang valid.`,
          );
        }
      }

      try {
        const result = calculateOpnameProduct(domainInput);
        calculatedResults.push(result);

        const expectedQty = openingQty + inQty - returnedQty;
        const diffQty = expectedQty - item.physicalQty;
        const totalLossQty = losses.reduce((acc, l) => acc + l.qty, 0);

        dbItems.push({
          productId: product.id,
          ownerType: product.ownerType,
          consignorId: product.consignorId,
          productNameSnapshot: product.name,
          sellPriceSnapshot: product.sellPrice,
          marginTypeSnapshot: product.marginType,
          marginValueSnapshot: product.marginValue,
          pcsPerPackSnapshot: product.pcsPerPack,
          openingQty,
          openingValue: toDbString(openingValue),
          inQty,
          inCost: toDbString(inCost),
          returnedQty,
          expectedQty,
          physicalQty: item.physicalQty,
          diffQty,
          lossQty: totalLossQty,
          soldQty: result.soldQty,
          avgCost: toDbString(result.costing?.avgCost ?? ZERO_MONEY),
          cogs: toDbString(result.costing?.cogs ?? ZERO_MONEY),
          ownLossCost: toDbString(result.costing?.ownLossCost ?? ZERO_MONEY),
          closingValue: toDbString(result.costing?.closingValue ?? ZERO_MONEY),
          turnover: toDbString(result.turnover),
          ownerMarginPerPcs: toDbString(
            product.ownerType === 'own'
              ? result.marginPerPcsOwn ?? ZERO_MONEY
              : result.ownerMarginPerPcsConsignor ?? ZERO_MONEY,
          ),
          consignorSharePerPcs: toDbString(result.consignorSharePerPcs ?? ZERO_MONEY),
          soldShare: toDbString(result.soldShare ?? ZERO_MONEY),
          lossQtyOwnerBorne: result.lossQtyOwnerBorne ?? 0,
          lossCompensation: toDbString(result.lossCompensation ?? ZERO_MONEY),
          payoutDue: toDbString(result.payoutDue ?? ZERO_MONEY),
        });
      } catch (err: unknown) {
        if (err instanceof NegativeDiffStockError) {
          const expected = openingQty + inQty - returnedQty;
          throw new AppError(
            400,
            'NEGATIVE_DIFF_STOCK',
            `Produk "${product.name}": Stok fisik (${item.physicalQty}) lebih banyak dari stok teoritis (${expected}). Periksa barang masuk yang belum tercatat.`,
          );
        }
        if (err instanceof LossExceedsDiffStockError) {
          const expected = openingQty + inQty - returnedQty;
          const diff = expected - item.physicalQty;
          const totalLoss = losses.reduce((acc, l) => acc + l.qty, 0);
          throw new AppError(
            400,
            'LOSS_EXCEEDS_DIFF_STOCK',
            `Produk "${product.name}": Total loss (${totalLoss}) melebihi selisih stok (${diff}).`,
          );
        }
        if (err instanceof DomainError) {
          throw new AppError(400, err.code, `Produk "${product.name}": ${err.message}`);
        }
        throw err;
      }
    }

    const payoutMap = calculateConsignorPayouts(calculatedResults);
    const dbPayouts: { consignorId: number; soldShare: string; lossCompensation: string; payoutDue: string }[] = [];

    for (const [consignorIdStr, p] of payoutMap.entries()) {
      dbPayouts.push({
        consignorId: Number(consignorIdStr),
        soldShare: toDbString(p.soldShare),
        lossCompensation: toDbString(p.lossCompensation),
        payoutDue: toDbString(p.payoutDue),
      });
    }

    const totalTurnover = toDbString(
      calculatedResults.reduce((acc, r) => addMoney(acc, r.turnover), ZERO_MONEY),
    );
    const totalSoldQty = calculatedResults.reduce((acc, r) => acc + r.soldQty, 0);
    const totalLossQty = calculatedResults.reduce((acc, r) => acc + r.lossQty, 0);
    const totalCogs = toDbString(
      calculatedResults.reduce((acc, r) => addMoney(acc, r.costing?.cogs ?? ZERO_MONEY), ZERO_MONEY),
    );
    const totalPayoutDue = toDbString(
      dbPayouts.reduce((acc, p) => addMoney(acc, p.payoutDue), ZERO_MONEY),
    );
    const modalBelanjaOwn = await opnameRepo.getModalBelanjaOwnForOpname(
      opnameDate,
      existingOpnameId,
      db,
    );

    const recResult: ReconciliationResult = calculateReconciliation({
      products: calculatedResults,
      cashAmount: cashAmountStr,
      qrisAmount: qrisAmountStr,
      modalBelanjaOwn,
    });

    const totals: OpnameTotals = {
      totalTurnover,
      totalSoldQty,
      totalLossQty,
      totalCogs,
      totalPayoutDue,
      cashAmount: toDbString(recResult.cashAmount),
      qrisAmount: toDbString(recResult.qrisAmount),
      realCash: toDbString(recResult.realCash),
      cashDifference: toDbString(recResult.cashDifference),
      profitA: toDbString(recResult.profitA),
      profitB: toDbString(recResult.profitB),
    };

    return {
      calculatedItems: dbItems,
      calculatedPayouts: dbPayouts,
      totals,
      reconciliation: {
        theoreticalTurnover: toDbString(recResult.theoreticalTurnover),
        realCash: toDbString(recResult.realCash),
        cashDifference: toDbString(recResult.cashDifference),
        cashDifferenceHint: recResult.cashDifferenceHint,
        profitA: toDbString(recResult.profitA),
        profitB: toDbString(recResult.profitB),
        profitDiff: toDbString(recResult.profitDiff),
        invariantI3Satisfied: recResult.invariantI3Satisfied,
      },
    };
  }

  return {
    async prepareOpnameSheet(date: string): Promise<{
      opnameDate: string;
      existingOpname: OpnameEntity | null;
      products: PreparedSheetProduct[];
    }> {
      const prevClosing = await opnameRepo.findPreviousOpname(date, pool);
      const openMovements = await opnameRepo.findOpenMovements(date, pool);

      const { data: activeProducts } = await productRepo.findAll({
        page: 1,
        limit: 1000,
        isActive: 'true',
      });

      const productMap = new Map<number, ProductEntity>();
      for (const p of activeProducts) {
        productMap.set(p.id, p);
      }

      for (const [productId] of prevClosing) {
        if (!productMap.has(productId)) {
          const p = await productRepo.findById(productId);
          if (p) productMap.set(p.id, p);
        }
      }

      for (const [productId] of openMovements) {
        if (!productMap.has(productId)) {
          const p = await productRepo.findById(productId);
          if (p) productMap.set(p.id, p);
        }
      }

      const existingHeader = await opnameRepo.findByDate(date, pool);
      let existingOpname: OpnameEntity | null = null;
      if (existingHeader) {
        existingOpname = await opnameRepo.findById(existingHeader.id, pool);
      }

      const draftPhysicalMap = new Map<number, number>();
      if (existingOpname && existingOpname.status === 'draft' && existingOpname.items) {
        for (const it of existingOpname.items) {
          draftPhysicalMap.set(it.productId, it.physicalQty);
        }
      }

      const sheetProducts: PreparedSheetProduct[] = Array.from(productMap.values()).map((product) => {
        const prev = prevClosing.get(product.id);
        const openingQty = prev?.closingQty ?? 0;
        const openingValue = prev?.closingValue ?? '0.0000';

        const mov = openMovements.get(product.id);
        const inQty = mov?.inQty ?? 0;
        const inCost = mov?.inCost ?? '0.0000';
        const returnedQty = mov?.returnedQty ?? 0;
        const losses = (mov?.losses ?? []) as LossItem[];
        const lossQty = losses.reduce((sum, l) => sum + l.qty, 0);
        const expectedQty = openingQty + inQty - returnedQty;

        return {
          productId: product.id,
          productName: product.name,
          ownerType: product.ownerType,
          consignorId: product.consignorId,
          consignorName: product.consignorName,
          pcsPerPack: product.pcsPerPack,
          sellPrice: product.sellPrice,
          marginType: product.marginType,
          marginValue: product.marginValue,
          openingQty,
          openingValue,
          inQty,
          inCost,
          returnedQty,
          expectedQty,
          lossQty,
          losses,
          draftPhysicalQty: draftPhysicalMap.get(product.id) ?? null,
        };
      });

      sheetProducts.sort((a, b) => a.productName.localeCompare(b.productName, 'id'));

      return {
        opnameDate: date,
        existingOpname,
        products: sheetProducts,
      };
    },

    async calculateDraft(
      opnameDate: string,
      items: PhysicalItemInput[],
      cashAmount = '0',
      qrisAmount = '0',
    ) {
      const existing = await opnameRepo.findByDate(opnameDate, pool);
      return computeOpnameData(
        opnameDate,
        items,
        cashAmount,
        qrisAmount,
        existing ? existing.id : null,
        pool,
      );
    },

    async saveDraft(
      userId: number,
      input: SaveDraftOpnameInput,
      meta?: AuditMeta,
    ): Promise<OpnameEntity> {
      const now = clock();

      const existing = await opnameRepo.findByDate(input.opnameDate, pool);
      if (existing && existing.status === 'final') {
        throw new AppError(
          409,
          'PERIOD_ALREADY_FINALIZED',
          'Opname pada tanggal ini sudah difinalisasi dan tidak dapat disimpan sebagai draft.',
        );
      }

      const { calculatedItems, calculatedPayouts, totals } = await computeOpnameData(
        input.opnameDate,
        input.items,
        input.cashAmount ?? '0',
        input.qrisAmount ?? '0',
        existing ? existing.id : null,
        pool,
      );

      return withTransaction(pool, async (conn) => {
        const opnameId = await opnameRepo.saveOpnameHeader(
          {
            opnameDate: input.opnameDate,
            status: 'draft',
            note: input.note ?? null,
            totalTurnover: totals.totalTurnover,
            totalSoldQty: totals.totalSoldQty,
            totalLossQty: totals.totalLossQty,
            totalCogs: totals.totalCogs,
            totalPayoutDue: totals.totalPayoutDue,
            cashAmount: totals.cashAmount,
            qrisAmount: totals.qrisAmount,
            realCash: totals.realCash,
            cashDifference: totals.cashDifference,
            profitA: totals.profitA,
            profitB: totals.profitB,
          },
          conn,
        );

        await opnameRepo.saveOpnameItems(opnameId, calculatedItems, conn);
        await opnameRepo.saveOpnamePayouts(opnameId, calculatedPayouts, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'opname.draft_saved',
          entityType: 'opname',
          entityId: String(opnameId),
          after: {
            id: opnameId,
            opnameDate: input.opnameDate,
            status: 'draft',
            note: input.note ?? null,
            totals,
          },
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        const saved = await opnameRepo.findById(opnameId, conn);
        if (!saved) {
          throw new Error('Gagal mengambil data opname draft yang baru disimpan');
        }
        return saved;
      });
    },

    async finalizeOpname(
      userId: number,
      input: FinalizeOpnameInput,
      meta?: AuditMeta,
    ): Promise<OpnameEntity> {
      const now = clock();

      const existing = await opnameRepo.findByDate(input.opnameDate, pool);
      if (existing && existing.status === 'final') {
        throw new AppError(
          409,
          'PERIOD_ALREADY_FINALIZED',
          'Opname pada tanggal ini sudah difinalisasi.',
        );
      }

      const { calculatedItems, calculatedPayouts, totals } = await computeOpnameData(
        input.opnameDate,
        input.items,
        input.cashAmount ?? '0',
        input.qrisAmount ?? '0',
        existing ? existing.id : null,
        pool,
      );

      return withTransaction(pool, async (conn) => {
        const opnameId = await opnameRepo.saveOpnameHeader(
          {
            opnameDate: input.opnameDate,
            status: 'final',
            note: input.note ?? null,
            totalTurnover: totals.totalTurnover,
            totalSoldQty: totals.totalSoldQty,
            totalLossQty: totals.totalLossQty,
            totalCogs: totals.totalCogs,
            totalPayoutDue: totals.totalPayoutDue,
            cashAmount: totals.cashAmount,
            qrisAmount: totals.qrisAmount,
            realCash: totals.realCash,
            cashDifference: totals.cashDifference,
            profitA: totals.profitA,
            profitB: totals.profitB,
          },
          conn,
        );

        await opnameRepo.saveOpnameItems(opnameId, calculatedItems, conn);
        await opnameRepo.saveOpnamePayouts(opnameId, calculatedPayouts, conn);

        // Attach all open movements <= opnameDate
        await opnameRepo.attachMovementsToOpname(opnameId, input.opnameDate, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'opname.finalized',
          entityType: 'opname',
          entityId: String(opnameId),
          after: {
            id: opnameId,
            opnameDate: input.opnameDate,
            status: 'final',
            note: input.note ?? null,
            totals,
          },
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        const finalized = await opnameRepo.findById(opnameId, conn);
        if (!finalized) {
          throw new Error('Gagal mengambil data opname yang baru difinalisasi');
        }
        return finalized;
      });
    },

    async getOpnameById(id: number): Promise<OpnameEntity> {
      const opname = await opnameRepo.findById(id, pool);
      if (!opname) {
        throw new AppError(404, 'OPNAME_NOT_FOUND', `Data opname dengan ID ${id} tidak ditemukan.`);
      }
      return opname;
    },

    async listOpnames(query: ListOpnamesQuery): Promise<{
      data: OpnameEntity[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }> {
      const filterOptions: OpnameFilterOptions = {
        page: query.page,
        limit: query.limit,
        status: query.status,
        startDate: query.startDate,
        endDate: query.endDate,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      };

      const { data, total } = await opnameRepo.list(filterOptions, pool);
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

    async deleteDraft(userId: number, id: number, meta?: AuditMeta): Promise<void> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await opnameRepo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'OPNAME_NOT_FOUND', `Data opname dengan ID ${id} tidak ditemukan.`);
        }

        if (existing.status !== 'draft') {
          throw new AppError(
            409,
            'CANNOT_DELETE_FINAL_OPNAME',
            'Opname yang sudah final tidak dapat dihapus.',
          );
        }

        await opnameRepo.deleteDraft(id, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'opname.draft_deleted',
          entityType: 'opname',
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
