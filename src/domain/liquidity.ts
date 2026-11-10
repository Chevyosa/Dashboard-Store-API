import { Decimal } from 'decimal.js';
import { InvalidMoneyError } from './errors.js';
import { addMoney, isNegativeMoney, parseMoney, subMoney, ZERO_MONEY, type MoneyInput } from './money.js';

export interface LiquidityInput {
  /** Signed ledger movements of the single combined liquid-funds pool (opening balance is one movement). */
  movements: MoneyInput[];
  /** Minimum cash that must stay in the pool. Must be non-negative. */
  minimumReserve: MoneyInput;
  /** Unpaid obligations that must be covered from the pool. Each must be non-negative. */
  unpaidObligations: MoneyInput[];
}

export interface LiquidityResult {
  liquidBalance: Decimal;
  minimumReserve: Decimal;
  unpaidObligations: Decimal;
  /** minimumReserve + unpaidObligations */
  requiredFunds: Decimal;
  /** max(0, liquidBalance - requiredFunds) */
  safeToWithdraw: Decimal;
  /** max(0, requiredFunds - liquidBalance) */
  shortfall: Decimal;
}

function parseNonNegative(value: MoneyInput, label: string): Decimal {
  const parsed = parseMoney(value);
  if (isNegativeMoney(parsed)) {
    throw new InvalidMoneyError(`${label} tidak boleh negatif`);
  }
  return parsed;
}

export interface PerEntityObligationsInput {
  /** Total accrued per stable entity ID (consignor ID, stock receipt ID, ...). Each must be non-negative. */
  accrued: ReadonlyMap<string, MoneyInput>;
  /** Total paid per stable entity ID. Each must be non-negative. Keys absent from `accrued` contribute zero. */
  paid: ReadonlyMap<string, MoneyInput>;
}

/**
 * Sums unpaid obligations per entity so one entity's overpayment cannot cancel another's debt:
 *   unpaid = sum over entities of max(0, accrued[id] - paid[id])
 */
export function sumUnpaidPerEntity(input: PerEntityObligationsInput): Decimal {
  const paidById = new Map<string, Decimal>();
  for (const [id, value] of input.paid) {
    paidById.set(id, parseNonNegative(value, 'Jumlah dibayar'));
  }

  let total = ZERO_MONEY;
  for (const [id, value] of input.accrued) {
    const accrued = parseNonNegative(value, 'Jumlah terutang');
    const unpaid = subMoney(accrued, paidById.get(id) ?? ZERO_MONEY);
    total = addMoney(total, Decimal.max(ZERO_MONEY, unpaid));
  }
  return total;
}

/**
 * Pure liquidity calculator for the single combined liquid-funds pool.
 *   liquidBalance  = sum(movements)
 *   requiredFunds  = minimumReserve + sum(unpaidObligations)
 *   safeToWithdraw = max(0, liquidBalance - requiredFunds)
 *   shortfall      = max(0, requiredFunds - liquidBalance)
 */
export function calculateLiquidity(input: LiquidityInput): LiquidityResult {
  const liquidBalance = input.movements.reduce<Decimal>(
    (sum, movement) => addMoney(sum, movement),
    ZERO_MONEY,
  );
  const minimumReserve = parseNonNegative(input.minimumReserve, 'Cadangan minimum');
  const unpaidObligations = input.unpaidObligations.reduce<Decimal>(
    (sum, obligation) => addMoney(sum, parseNonNegative(obligation, 'Kewajiban belum dibayar')),
    ZERO_MONEY,
  );
  const requiredFunds = addMoney(minimumReserve, unpaidObligations);
  const surplus = subMoney(liquidBalance, requiredFunds);

  return {
    liquidBalance,
    minimumReserve,
    unpaidObligations,
    requiredFunds,
    safeToWithdraw: Decimal.max(ZERO_MONEY, surplus),
    shortfall: Decimal.max(ZERO_MONEY, surplus.negated()),
  };
}
