import { Decimal } from 'decimal.js';
import {
  calculateOwnCosting,
  type OwnStockCostingResult,
} from './costing.js';
import {
  InvalidLossBorneByError,
  InvalidQuantityError,
  LossExceedsDiffStockError,
  NegativeDiffStockError,
} from './errors.js';
import {
  calculateConsignorMargin,
  calculateOwnMargin,
  type MarginScheme,
} from './margin.js';
import {
  addMoney,
  mulMoney,
  parseMoney,
  subMoney,
  ZERO_MONEY,
  type MoneyInput,
} from './money.js';

export type LossReason =
  | 'expired'
  | 'damaged_on_display'
  | 'damaged_before_display'
  | 'lost'
  | 'other';

export type LossBorneBy = 'owner' | 'consignor';

export interface LossItem {
  qty: number;
  reason: LossReason;
  borneBy: LossBorneBy;
  note?: string;
}

/**
 * Returns default borne_by for loss reasons (§5.6).
 * Own products are always locked to 'owner'.
 * Consignor defaults:
 *   - expired: consignor
 *   - damaged_on_display: owner
 *   - damaged_before_display: consignor
 *   - lost: owner
 *   - other: owner
 */
export function getDefaultLossBorneBy(
  ownerType: 'own' | 'consignor',
  reason: LossReason,
): LossBorneBy {
  if (ownerType === 'own') {
    return 'owner';
  }

  switch (reason) {
    case 'expired':
    case 'damaged_before_display':
      return 'consignor';
    case 'damaged_on_display':
    case 'lost':
    case 'other':
    default:
      return 'owner';
  }
}

export interface OpnameProductInput {
  productId: string;
  productName?: string | undefined;
  ownerType: 'own' | 'consignor';
  consignorId?: string | null | undefined;
  openingQty: number;
  inQty: number;
  returnedQty?: number | undefined;
  physicalQty: number;
  losses?: LossItem[] | undefined;
  sellPrice: MoneyInput;
  // For own products
  openingValue?: MoneyInput | undefined;
  inCost?: MoneyInput | undefined;
  pcsPerPack?: number | undefined;
  // For consignor products
  marginScheme?: MarginScheme | undefined;
}

export interface OpnameProductResult {
  productId: string;
  productName?: string | undefined;
  ownerType: 'own' | 'consignor';
  consignorId: string | null;
  openingQty: number;
  inQty: number;
  returnedQty: number;
  expectedQty: number;
  physicalQty: number;
  diffQty: number;
  lossQty: number;
  soldQty: number;
  sellPrice: Decimal;
  turnover: Decimal; // soldQty * sellPrice

  // Own-specific results
  costing?: OwnStockCostingResult | undefined;
  marginPerPcsOwn?: Decimal | undefined;
  marginTotalOwn?: Decimal | undefined;

  // Consignor-specific results
  ownerMarginPerPcsConsignor?: Decimal | undefined;
  consignorSharePerPcs?: Decimal | undefined;
  soldShare?: Decimal | undefined;
  lossQtyOwnerBorne?: number | undefined;
  lossCompensation?: Decimal | undefined;
  payoutDue?: Decimal | undefined;
  ownerMarginTotalConsignor?: Decimal | undefined;
}

/**
 * Calculates stock reconciliation, sold quantities, loss allocations, and financial
 * amounts for an individual product in an opname period (§5.4, §5.5, §5.6).
 * Enforces Invariant I1:
 *   expected_qty = opening_qty + in_qty - returned_qty
 *   diff_qty = expected_qty - physical_qty (>= 0)
 *   sold_qty = diff_qty - loss_qty (>= 0)
 */
export function calculateOpnameProduct(input: OpnameProductInput): OpnameProductResult {
  const {
    productId,
    productName,
    ownerType,
    consignorId = null,
    openingQty,
    inQty,
    returnedQty = 0,
    physicalQty,
    losses = [],
  } = input;

  if (!Number.isInteger(openingQty) || openingQty < 0) {
    throw new InvalidQuantityError('Opening qty harus berupa bilangan bulat non-negatif');
  }
  if (!Number.isInteger(inQty) || inQty < 0) {
    throw new InvalidQuantityError('Incoming qty harus berupa bilangan bulat non-negatif');
  }
  if (!Number.isInteger(returnedQty) || returnedQty < 0) {
    throw new InvalidQuantityError('Returned qty harus berupa bilangan bulat non-negatif');
  }
  if (!Number.isInteger(physicalQty) || physicalQty < 0) {
    throw new InvalidQuantityError('Stok fisik (physical_qty) harus berupa bilangan bulat non-negatif');
  }

  // Returns only apply to titipan (§5.7)
  if (ownerType === 'own' && returnedQty > 0) {
    throw new InvalidQuantityError('Produk milik sendiri tidak dapat memiliki retur penitip');
  }

  const sellPrice = parseMoney(input.sellPrice);

  // Validate losses
  let totalLossQty = 0;
  let lossQtyOwnerBorne = 0;

  for (const loss of losses) {
    if (!Number.isInteger(loss.qty) || loss.qty <= 0) {
      throw new InvalidQuantityError('Qty loss harus berupa bilangan bulat positif (> 0)');
    }

    if (ownerType === 'own' && loss.borneBy !== 'owner') {
      throw new InvalidLossBorneByError();
    }

    totalLossQty += loss.qty;
    if (loss.borneBy === 'owner') {
      lossQtyOwnerBorne += loss.qty;
    }
  }

  // Stock equations (§5.5)
  const expectedQty = openingQty + inQty - returnedQty;
  if (expectedQty < 0) {
    throw new InvalidQuantityError('Stok teoritis (expected_qty) tidak boleh negatif');
  }

  const diffQty = expectedQty - physicalQty;
  if (diffQty < 0) {
    throw new NegativeDiffStockError();
  }

  const soldQty = diffQty - totalLossQty;
  if (soldQty < 0) {
    throw new LossExceedsDiffStockError();
  }

  const turnover = mulMoney(sellPrice, soldQty.toString());

  const result: OpnameProductResult = {
    productId,
    productName,
    ownerType,
    consignorId,
    openingQty,
    inQty,
    returnedQty,
    expectedQty,
    physicalQty,
    diffQty,
    lossQty: totalLossQty,
    soldQty,
    sellPrice,
    turnover,
  };

  if (ownerType === 'own') {
    const openingValue = input.openingValue ?? ZERO_MONEY;
    const inCost = input.inCost ?? ZERO_MONEY;
    const pcsPerPack = input.pcsPerPack ?? 1;

    const costing = calculateOwnCosting({
      openingQty,
      openingValue,
      inQty,
      inCost,
      physicalQty,
      soldQty,
      lossQty: totalLossQty,
    });

    const marginInfo = calculateOwnMargin(sellPrice, costing.avgCost, pcsPerPack);

    result.costing = costing;
    result.marginPerPcsOwn = marginInfo.marginPerPcs;
    result.marginTotalOwn = subMoney(turnover, costing.cogs);
  } else {
    if (!input.marginScheme) {
      throw new Error('Skema margin wajib diisi untuk produk titipan');
    }

    const marginInfo = calculateConsignorMargin(sellPrice, input.marginScheme);
    const consignorSharePerPcs = marginInfo.consignorSharePerPcs;
    const ownerMarginPerPcsConsignor = marginInfo.ownerMarginPerPcs;

    const soldShare = mulMoney(consignorSharePerPcs, soldQty.toString());
    const lossCompensation = mulMoney(consignorSharePerPcs, lossQtyOwnerBorne.toString());
    const payoutDue = addMoney(soldShare, lossCompensation);
    const ownerMarginTotalConsignor = mulMoney(ownerMarginPerPcsConsignor, soldQty.toString());

    result.ownerMarginPerPcsConsignor = ownerMarginPerPcsConsignor;
    result.consignorSharePerPcs = consignorSharePerPcs;
    result.soldShare = soldShare;
    result.lossQtyOwnerBorne = lossQtyOwnerBorne;
    result.lossCompensation = lossCompensation;
    result.payoutDue = payoutDue;
    result.ownerMarginTotalConsignor = ownerMarginTotalConsignor;
  }

  return result;
}
