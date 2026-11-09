import { Decimal } from 'decimal.js';
import { InvalidMoneyError } from './errors.js';
import {
  addMoney,
  parseMoney,
  subMoney,
  ZERO_MONEY,
  type MoneyInput,
} from './money.js';
import type { OpnameProductResult } from './opname.js';

export interface ConsignorOpnamePayout {
  consignorId: string;
  soldShare: Decimal;
  lossCompensation: Decimal;
  payoutDue: Decimal;
  products: OpnameProductResult[];
}

export type ConsignorLedgerStatus = 'unpaid' | 'settled' | 'overpaid';

export interface ConsignorLedgerSummary {
  consignorId: string;
  totalAccrual: Decimal;
  totalPayment: Decimal;
  balance: Decimal;
  status: ConsignorLedgerStatus;
}

/**
 * Calculates payouts due per consignor from opname product results (§5.7).
 * For each consignor:
 *   sold_share = sum(sold_qty * consignor_share_per_pcs)
 *   loss_compensation = sum(loss_qty_owner_borne * consignor_share_per_pcs)
 *   payout_due = sold_share + loss_compensation
 */
export function calculateConsignorPayouts(
  products: OpnameProductResult[],
): Map<string, ConsignorOpnamePayout> {
  const payoutMap = new Map<string, ConsignorOpnamePayout>();

  for (const product of products) {
    if (product.ownerType !== 'consignor' || !product.consignorId) {
      continue;
    }

    const { consignorId, soldShare = ZERO_MONEY, lossCompensation = ZERO_MONEY } = product;

    const existing = payoutMap.get(consignorId) ?? {
      consignorId,
      soldShare: ZERO_MONEY,
      lossCompensation: ZERO_MONEY,
      payoutDue: ZERO_MONEY,
      products: [],
    };

    existing.soldShare = addMoney(existing.soldShare, soldShare);
    existing.lossCompensation = addMoney(existing.lossCompensation, lossCompensation);
    existing.payoutDue = addMoney(existing.soldShare, existing.lossCompensation);
    existing.products.push(product);

    payoutMap.set(consignorId, existing);
  }

  return payoutMap;
}

/**
 * Calculates the balance and payment status of a consignor ledger (§5.7).
 * saldo = sum(accruals) - sum(payments)
 * Status:
 *   saldo > 0 -> 'unpaid'
 *   saldo === 0 -> 'settled'
 *   saldo < 0 -> 'overpaid'
 * Invariant I4: saldo === totalAccrual - totalPayment
 */
export function calculateConsignorLedger(
  consignorId: string,
  accruals: MoneyInput[],
  payments: MoneyInput[],
): ConsignorLedgerSummary {
  let totalAccrual = ZERO_MONEY;
  for (const acc of accruals) {
    const parsed = parseMoney(acc);
    if (parsed.isNegative()) {
      throw new InvalidMoneyError('Nilai accrual tidak boleh negatif');
    }
    totalAccrual = addMoney(totalAccrual, parsed);
  }

  let totalPayment = ZERO_MONEY;
  for (const pay of payments) {
    const parsed = parseMoney(pay);
    if (parsed.isNegative()) {
      throw new InvalidMoneyError('Nominal pembayaran penitip tidak boleh negatif');
    }
    totalPayment = addMoney(totalPayment, parsed);
  }

  const balance = subMoney(totalAccrual, totalPayment);

  let status: ConsignorLedgerStatus;
  if (balance.gt(ZERO_MONEY)) {
    status = 'unpaid';
  } else if (balance.isZero()) {
    status = 'settled';
  } else {
    status = 'overpaid';
  }

  return {
    consignorId,
    totalAccrual,
    totalPayment,
    balance,
    status,
  };
}
