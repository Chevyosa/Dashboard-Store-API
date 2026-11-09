import { Decimal } from 'decimal.js';
import { InvalidMoneyError } from './errors.js';
import {
  addMoney,
  parseMoney,
  subMoney,
  toDisplayString,
  ZERO_MONEY,
  type MoneyInput,
} from './money.js';
import type { OpnameProductResult } from './opname.js';
import { calculateConsignorPayouts } from './payout.js';

export interface ReconciliationInput {
  products: OpnameProductResult[];
  qrisAmount: MoneyInput;
  cashAmount: MoneyInput;
  modalBelanjaOwn: MoneyInput; // total biaya belanja own periode ini
}

export interface ReconciliationResult {
  // Turnover & Actual Cash
  theoreticalTurnover: Decimal; // T
  turnoverOwn: Decimal; // T_own
  turnoverConsignor: Decimal; // T_consignor
  qrisAmount: Decimal;
  cashAmount: Decimal;
  realCash: Decimal; // R = QRIS + cash
  cashDifference: Decimal; // R - T
  cashDifferenceHint: string;

  // Costs & Payouts
  totalCogs: Decimal;
  totalOwnLossCost: Decimal;
  totalLossCompensation: Decimal;
  totalOpeningValue: Decimal;
  totalClosingValue: Decimal;
  modalBelanjaOwn: Decimal;
  totalPayoutDue: Decimal;

  // Dual Profit Views (§5.8)
  profitA: Decimal; // Goods-based: (T_own - COGS) + Margin_titipan - Own_loss - Loss_comp
  profitB: Decimal; // Cash-based: R - Payout - Modal_belanja
  profitDiff: Decimal; // B - A

  // Invariant I3 verification: (R - T) + (Opening - Closing) === B - A
  invariantI3Satisfied: boolean;
}

/**
 * Calculates theoretical turnover T, real cash R, cash discrepancy, consignor payouts,
 * and both Profit A and Profit B (§5.8).
 * Enforces Invariant I3:
 *   Profit B - Profit A === (R - T) + (opening_value_total - closing_value_total)
 */
export function calculateReconciliation(input: ReconciliationInput): ReconciliationResult {
  const qrisAmount = parseMoney(input.qrisAmount);
  const cashAmount = parseMoney(input.cashAmount);
  const modalBelanjaOwn = parseMoney(input.modalBelanjaOwn);

  if (qrisAmount.isNegative()) {
    throw new InvalidMoneyError('Nominal QRIS tidak boleh negatif');
  }
  if (cashAmount.isNegative()) {
    throw new InvalidMoneyError('Nominal cash tidak boleh negatif');
  }
  if (modalBelanjaOwn.isNegative()) {
    throw new InvalidMoneyError('Modal belanja tidak boleh negatif');
  }

  const realCash = addMoney(qrisAmount, cashAmount); // R

  let theoreticalTurnover = ZERO_MONEY; // T
  let turnoverOwn = ZERO_MONEY;
  let turnoverConsignor = ZERO_MONEY;
  let totalCogs = ZERO_MONEY;
  let totalOwnLossCost = ZERO_MONEY;
  let totalOpeningValue = ZERO_MONEY;
  let totalClosingValue = ZERO_MONEY;
  let totalConsignorOwnerMargin = ZERO_MONEY;
  let totalLossCompensation = ZERO_MONEY;

  for (const p of input.products) {
    theoreticalTurnover = addMoney(theoreticalTurnover, p.turnover);

    if (p.ownerType === 'own') {
      turnoverOwn = addMoney(turnoverOwn, p.turnover);
      const costing = p.costing;
      totalCogs = addMoney(totalCogs, costing?.cogs ?? ZERO_MONEY);
      totalOwnLossCost = addMoney(totalOwnLossCost, costing?.ownLossCost ?? ZERO_MONEY);
      totalOpeningValue = addMoney(totalOpeningValue, costing?.openingValue ?? ZERO_MONEY);
      totalClosingValue = addMoney(totalClosingValue, costing?.closingValue ?? ZERO_MONEY);
    } else {
      turnoverConsignor = addMoney(turnoverConsignor, p.turnover);
      totalConsignorOwnerMargin = addMoney(
        totalConsignorOwnerMargin,
        p.ownerMarginTotalConsignor ?? ZERO_MONEY,
      );
      totalLossCompensation = addMoney(
        totalLossCompensation,
        p.lossCompensation ?? ZERO_MONEY,
      );
    }
  }

  // Calculate payouts due to consignors
  const consignorPayoutMap = calculateConsignorPayouts(input.products);
  let totalPayoutDue = ZERO_MONEY;
  for (const payout of consignorPayoutMap.values()) {
    totalPayoutDue = addMoney(totalPayoutDue, payout.payoutDue);
  }

  // Cash discrepancy: R - T
  const cashDifference = subMoney(realCash, theoreticalTurnover);

  let cashDifferenceHint: string;
  if (cashDifference.isZero()) {
    cashDifferenceHint = 'Uang riil cocok dengan omset teoritis.';
  } else if (cashDifference.isPositive()) {
    cashDifferenceHint = `Kelebihan uang riil sebesar Rp ${toDisplayString(cashDifference)} (kemungkinan: uang modal tercampur, salah hitung fisik, atau pembeli tidak mengambil kembalian).`;
  } else {
    const diffAbs = cashDifference.abs();
    cashDifferenceHint = `Kekurangan uang riil sebesar Rp ${toDisplayString(diffAbs)} (kemungkinan: kasbon pelanggan belum dicatat, loss belum terdata, atau salah hitung fisik).`;
  }

  // Profit A (basis barang) = (T_own - COGS) + Margin_titipan - own_loss_cost - loss_compensation_total
  const ownGrossMargin = subMoney(turnoverOwn, totalCogs);
  const profitA = subMoney(
    addMoney(ownGrossMargin, totalConsignorOwnerMargin),
    addMoney(totalOwnLossCost, totalLossCompensation),
  );

  // Profit B (basis kas) = R - payout_total - modal_belanja
  const profitB = subMoney(subMoney(realCash, totalPayoutDue), modalBelanjaOwn);

  const profitDiff = subMoney(profitB, profitA); // B - A

  // Invariant I3 verification: (R - T) + (opening_value_total - closing_value_total)
  const stockValueChange = subMoney(totalOpeningValue, totalClosingValue);
  const expectedDiff = addMoney(cashDifference, stockValueChange);
  const invariantI3Satisfied = profitDiff.equals(expectedDiff);

  return {
    theoreticalTurnover,
    turnoverOwn,
    turnoverConsignor,
    qrisAmount,
    cashAmount,
    realCash,
    cashDifference,
    cashDifferenceHint,
    totalCogs,
    totalOwnLossCost,
    totalLossCompensation,
    totalOpeningValue,
    totalClosingValue,
    modalBelanjaOwn,
    totalPayoutDue,
    profitA,
    profitB,
    profitDiff,
    invariantI3Satisfied,
  };
}
