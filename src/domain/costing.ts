import { Decimal } from 'decimal.js';
import { InvalidQuantityError, InvalidMoneyError } from './errors.js';
import {
  addMoney,
  mulMoney,
  parseMoney,
  ZERO_MONEY,
  type MoneyInput,
} from './money.js';

export interface OwnStockCostingInput {
  openingQty: number;
  openingValue: MoneyInput;
  inQty: number;
  inCost: MoneyInput;
  physicalQty: number;
  soldQty: number;
  lossQty: number;
}

export interface OwnStockCostingResult {
  avgCost: Decimal;
  openingQty: number;
  openingValue: Decimal;
  inQty: number;
  inCost: Decimal;
  totalQty: number;
  totalCost: Decimal;
  soldQty: number;
  cogs: Decimal;
  lossQty: number;
  ownLossCost: Decimal;
  physicalQty: number;
  closingValue: Decimal;
}

/**
 * Calculates periodic weighted average cost for own products (§5.4).
 * avg_cost = (opening_value + in_cost) / (opening_qty + in_qty)
 * If denominator is 0, avg_cost = 0.
 */
export function calculatePeriodicAvgCost(
  openingQty: number,
  openingValueInput: MoneyInput,
  inQty: number,
  inCostInput: MoneyInput,
): Decimal {
  if (!Number.isInteger(openingQty) || openingQty < 0) {
    throw new InvalidQuantityError('Opening qty harus berupa bilangan bulat non-negatif');
  }
  if (!Number.isInteger(inQty) || inQty < 0) {
    throw new InvalidQuantityError('Incoming qty harus berupa bilangan bulat non-negatif');
  }

  const openingValue = parseMoney(openingValueInput);
  const inCost = parseMoney(inCostInput);

  if (openingValue.isNegative()) {
    throw new InvalidMoneyError('Opening value tidak boleh negatif');
  }
  if (inCost.isNegative()) {
    throw new InvalidMoneyError('Incoming cost tidak boleh negatif');
  }

  const totalQty = openingQty + inQty;
  if (totalQty === 0) {
    return ZERO_MONEY;
  }

  const totalCost = addMoney(openingValue, inCost);
  return totalCost.dividedBy(new Decimal(totalQty));
}

/**
 * Calculates COGS, own loss cost, and closing value for own products (§5.4).
 * Enforces Invariant I2:
 *   opening_value + in_cost === COGS + own_loss_cost + closing_value
 */
export function calculateOwnCosting(input: OwnStockCostingInput): OwnStockCostingResult {
  const { openingQty, inQty, physicalQty, soldQty, lossQty } = input;

  if (!Number.isInteger(physicalQty) || physicalQty < 0) {
    throw new InvalidQuantityError('Stok fisik (physical_qty) harus berupa bilangan bulat non-negatif');
  }
  if (!Number.isInteger(soldQty) || soldQty < 0) {
    throw new InvalidQuantityError('Jumlah terjual (sold_qty) harus berupa bilangan bulat non-negatif');
  }
  if (!Number.isInteger(lossQty) || lossQty < 0) {
    throw new InvalidQuantityError('Jumlah loss (loss_qty) harus berupa bilangan bulat non-negatif');
  }

  const openingValue = parseMoney(input.openingValue);
  const inCost = parseMoney(input.inCost);
  const avgCost = calculatePeriodicAvgCost(openingQty, openingValue, inQty, inCost);

  const totalQty = openingQty + inQty;
  const totalCost = addMoney(openingValue, inCost);

  const cogs = mulMoney(avgCost, soldQty.toString());
  const ownLossCost = mulMoney(avgCost, lossQty.toString());
  const closingValue = mulMoney(avgCost, physicalQty.toString());

  return {
    avgCost,
    openingQty,
    openingValue,
    inQty,
    inCost,
    totalQty,
    totalCost,
    soldQty,
    cogs,
    lossQty,
    ownLossCost,
    physicalQty,
    closingValue,
  };
}
