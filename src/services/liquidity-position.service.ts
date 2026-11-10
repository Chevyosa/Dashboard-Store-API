import type { Decimal } from 'decimal.js';
import { calculateLiquidity, sumUnpaidPerEntity, type LiquidityResult } from '../domain/liquidity.js';
import { parseMoney } from '../domain/money.js';
import {
  LiquidityRepository,
  type Db,
  type LiquidityCutoverEntity,
} from '../repositories/liquidity.repository.js';
import { TakeProfitRepository } from '../repositories/take-profit.repository.js';

export const MIN_WORKING_CAPITAL_KEY = 'min_working_capital';
/** Fallback when the setting row is missing; matches the seed in migration 0012. */
export const DEFAULT_MIN_WORKING_CAPITAL = '400000.0000';

export interface LiquidityPosition extends LiquidityResult {
  /** Unpaid consignor payouts, floored per consignor (no cross-offset). */
  unpaidConsignorBalance: Decimal;
  /** Unpaid purchase-stock debt: legacy opening debt plus each post-cutover receipt, floored per entity. */
  unpaidStockPurchaseBalance: Decimal;
  /** liquidBalance - requiredFunds (signed). */
  surplus: Decimal;
}

const liquidityRepo = new LiquidityRepository();
const takeProfitRepo = new TakeProfitRepository();

export async function readMinWorkingCapital(db: Db): Promise<Decimal> {
  const saved = await takeProfitRepo.getSetting(MIN_WORKING_CAPITAL_KEY, db);
  return parseMoney(saved ?? DEFAULT_MIN_WORKING_CAPITAL);
}

/**
 * Current ledger-backed liquidity position after the cutover. Pass the
 * transaction connection that holds the cutover lock when the result guards a
 * write: every source write takes that lock first, so the position cannot move
 * until the caller commits.
 */
export async function computeLiquidityPosition(
  cutover: LiquidityCutoverEntity,
  db: Db,
): Promise<LiquidityPosition> {
  const balance = await liquidityRepo.sumEventBalance(db);
  const minimumReserve = await readMinWorkingCapital(db);
  const consignorTotals = await liquidityRepo.getConsignorObligationTotals(db);
  const stockTotals = await liquidityRepo.getPurchaseStockObligationTotals(cutover, db);

  const unpaidConsignorBalance = sumUnpaidPerEntity(consignorTotals);
  const unpaidStockPurchaseBalance = sumUnpaidPerEntity(stockTotals);

  const result = calculateLiquidity({
    movements: [balance],
    minimumReserve,
    unpaidObligations: [unpaidConsignorBalance, unpaidStockPurchaseBalance],
  });

  return {
    ...result,
    unpaidConsignorBalance,
    unpaidStockPurchaseBalance,
    surplus: result.liquidBalance.minus(result.requiredFunds),
  };
}
