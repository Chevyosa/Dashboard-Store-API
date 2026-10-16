import { Decimal } from 'decimal.js';
import type { Pool } from 'mysql2/promise';
import type { OpnameProductResult } from '../domain/opname.js';
import { toDbString } from '../domain/money.js';
import { calculateReconciliation, type ReconciliationResult } from '../domain/profit.js';
import { dashboardRepository, type DashboardRepository } from '../repositories/dashboard.repository.js';
import { OpnameRepository, type OpnameItemEntity } from '../repositories/opname.repository.js';
import { AppError } from '../utils/errors.js';
import type { Clock } from '../utils/time.js';
import type { ReconciliationInputParams } from '../validators/dashboard.js';

export interface DashboardServiceDeps {
  pool: Pool;
  clock?: Clock;
  dashboardRepo?: DashboardRepository;
  opnameRepo?: OpnameRepository;
}

export interface FormattedReconciliationResult {
  opnameId: number;
  opnameDate: string;
  theoreticalTurnover: string;
  turnoverOwn: string;
  turnoverConsignor: string;
  qrisAmount: string;
  cashAmount: string;
  realCash: string;
  cashDifference: string;
  cashDifferenceHint: string;
  totalCogs: string;
  totalOwnLossCost: string;
  totalLossCompensation: string;
  totalOpeningValue: string;
  totalClosingValue: string;
  modalBelanjaOwn: string;
  totalPayoutDue: string;
  profitA: string;
  profitB: string;
  profitDiff: string;
  invariantI3Satisfied: boolean;
}

export function createDashboardService(deps: DashboardServiceDeps) {
  const { pool } = deps;
  const dashRepo = deps.dashboardRepo ?? dashboardRepository;
  const opnameRepo = deps.opnameRepo ?? new OpnameRepository();

  async function computeReconciliationForOpname(
    opnameId: number,
    cashAmountStr: string,
    qrisAmountStr: string,
    customModalBelanjaOwnStr?: string,
  ): Promise<FormattedReconciliationResult> {
    const opname = await opnameRepo.findById(opnameId, pool);
    if (!opname) {
      throw new AppError(404, 'OPNAME_NOT_FOUND', `Opname dengan ID ${opnameId} tidak ditemukan.`);
    }

    const modalBelanjaOwnStr =
      customModalBelanjaOwnStr !== undefined
        ? customModalBelanjaOwnStr
        : await dashRepo.getModalBelanjaOwn(opnameId, pool);

    const items = opname.items ?? [];
    const domainProducts: OpnameProductResult[] = items.map((item: OpnameItemEntity) => {
      const isOwn = item.ownerType === 'own';
      return {
        productId: String(item.productId),
        productName: item.productNameSnapshot,
        ownerType: item.ownerType,
        consignorId: item.consignorId ? String(item.consignorId) : null,
        openingQty: item.openingQty,
        inQty: item.inQty,
        returnedQty: item.returnedQty,
        expectedQty: item.expectedQty,
        physicalQty: item.physicalQty,
        diffQty: item.diffQty,
        lossQty: item.lossQty,
        soldQty: item.soldQty,
        sellPrice: new Decimal(item.sellPriceSnapshot),
        turnover: new Decimal(item.turnover),
        costing: isOwn
          ? {
              openingQty: item.openingQty,
              openingValue: new Decimal(item.openingValue),
              inQty: item.inQty,
              inCost: new Decimal(item.inCost),
              totalQty: item.openingQty + item.inQty,
              totalCost: new Decimal(item.openingValue).add(new Decimal(item.inCost)),
              avgCost: new Decimal(item.avgCost),
              soldQty: item.soldQty,
              cogs: new Decimal(item.cogs),
              lossQty: item.lossQty,
              ownLossCost: new Decimal(item.ownLossCost),
              physicalQty: item.physicalQty,
              closingValue: new Decimal(item.closingValue),
            }
          : undefined,
        ownerMarginTotalConsignor: !isOwn
          ? new Decimal(item.ownerMarginPerPcs).mul(item.soldQty)
          : undefined,
        lossCompensation: !isOwn ? new Decimal(item.lossCompensation) : undefined,
        soldShare: !isOwn ? new Decimal(item.soldShare) : undefined,
        payoutDue: !isOwn ? new Decimal(item.payoutDue) : undefined,
      };
    });

    const recResult: ReconciliationResult = calculateReconciliation({
      products: domainProducts,
      cashAmount: cashAmountStr,
      qrisAmount: qrisAmountStr,
      modalBelanjaOwn: modalBelanjaOwnStr,
    });

    return {
      opnameId,
      opnameDate: opname.opnameDate,
      theoreticalTurnover: toDbString(recResult.theoreticalTurnover),
      turnoverOwn: toDbString(recResult.turnoverOwn),
      turnoverConsignor: toDbString(recResult.turnoverConsignor),
      qrisAmount: toDbString(recResult.qrisAmount),
      cashAmount: toDbString(recResult.cashAmount),
      realCash: toDbString(recResult.realCash),
      cashDifference: toDbString(recResult.cashDifference),
      cashDifferenceHint: recResult.cashDifferenceHint,
      totalCogs: toDbString(recResult.totalCogs),
      totalOwnLossCost: toDbString(recResult.totalOwnLossCost),
      totalLossCompensation: toDbString(recResult.totalLossCompensation),
      totalOpeningValue: toDbString(recResult.totalOpeningValue),
      totalClosingValue: toDbString(recResult.totalClosingValue),
      modalBelanjaOwn: toDbString(recResult.modalBelanjaOwn),
      totalPayoutDue: toDbString(recResult.totalPayoutDue),
      profitA: toDbString(recResult.profitA),
      profitB: toDbString(recResult.profitB),
      profitDiff: toDbString(recResult.profitDiff),
      invariantI3Satisfied: recResult.invariantI3Satisfied,
    };
  }

  return {
    async getSummary() {
      const overview = await dashRepo.getOverview(pool);

      let turnoverBreakdown = {
        ownTurnover: '0.0000',
        consignorTurnover: '0.0000',
        totalTurnover: '0.0000',
        ownPercentage: 0,
        consignorPercentage: 0,
      };
      let topProducts: {
        productId: number;
        name: string;
        ownerType: 'own' | 'consignor';
        soldQty: number;
        turnover: string;
      }[] = [];
      let latestReconciliation: FormattedReconciliationResult | null = null;

      if (overview.latestOpname) {
        turnoverBreakdown = await dashRepo.getTurnoverBreakdown(overview.latestOpname.id, pool);
        topProducts = await dashRepo.getTopSellingProducts(overview.latestOpname.id, 5, pool);
        // Default reconciliation: use the saved cashAmount and qrisAmount from the finalized opname
        try {
          latestReconciliation = await computeReconciliationForOpname(
            overview.latestOpname.id,
            overview.latestOpname.cashAmount,
            overview.latestOpname.qrisAmount,
          );
        } catch {
          latestReconciliation = null;
        }
      }

      const pendingPayoutConsignors = await dashRepo.getPendingPayoutConsignors(5, pool);
      const recentOpnames = await dashRepo.getRecentOpnames(5, pool);
      const opnameOptions = await dashRepo.getFinalizedOpnameOptions(pool);

      return {
        overview,
        turnoverBreakdown,
        topProducts,
        pendingPayoutConsignors,
        recentOpnames,
        opnameOptions,
        latestReconciliation,
      };
    },

    async calculateReconciliation(params: ReconciliationInputParams) {
      let opnameId = params.opnameId;

      if (!opnameId) {
        const overview = await dashRepo.getOverview(pool);
        if (!overview.latestOpname) {
          throw new AppError(
            404,
            'NO_FINALIZED_OPNAME',
            'Belum ada periode opname final untuk direkonsiliasi. Lakukan opname terlebih dahulu.',
          );
        }
        opnameId = overview.latestOpname.id;
      }

      return computeReconciliationForOpname(
        opnameId,
        params.cashAmount,
        params.qrisAmount,
        params.modalBelanjaOwn,
      );
    },
  };
}
