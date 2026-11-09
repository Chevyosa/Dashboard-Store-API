import { describe, expect, it } from 'vitest';
import { calculateOwnCosting } from '../../../src/domain/costing.js';
import { calculateConsignorMargin } from '../../../src/domain/margin.js';
import { addMoney, mulMoney, parseMoney } from '../../../src/domain/money.js';
import { calculateOpnameProduct } from '../../../src/domain/opname.js';
import { calculateConsignorLedger } from '../../../src/domain/payout.js';
import { calculateReconciliation } from '../../../src/domain/profit.js';

describe('Domain Invariants Verification (AGENTS.md §6)', () => {
  describe('Invariant I1: sold_qty = expected - physical - sum(loss) >= 0', () => {
    it('holds for various valid stock and loss combinations', () => {
      const cases = [
        { op: 10, in: 20, ret: 0, phys: 15, losses: [{ qty: 3, reason: 'lost' as const, borneBy: 'owner' as const }] },
        { op: 0, in: 50, ret: 0, phys: 0, losses: [] }, // all sold
        { op: 5, in: 5, ret: 2, phys: 0, losses: [{ qty: 8, reason: 'lost' as const, borneBy: 'owner' as const }] }, // all lost, none sold
        { op: 100, in: 0, ret: 0, phys: 100, losses: [] }, // none sold, none lost
        { op: 12, in: 8, ret: 4, phys: 6, losses: [{ qty: 2, reason: 'expired' as const, borneBy: 'consignor' as const }, { qty: 3, reason: 'lost' as const, borneBy: 'owner' as const }] },
      ];

      for (const c of cases) {
        const res = calculateOpnameProduct({
          productId: 'test-p',
          ownerType: c.ret > 0 ? 'consignor' : 'own',
          consignorId: c.ret > 0 ? 'c-1' : undefined,
          sellPrice: '5000',
          marginScheme: c.ret > 0 ? { type: 'nominal', marginValue: '1000' } : undefined,
          openingQty: c.op,
          inQty: c.in,
          returnedQty: c.ret,
          physicalQty: c.phys,
          losses: c.losses,
        });

        const expected = c.op + c.in - c.ret;
        const totalLoss = c.losses.reduce((acc, l) => acc + l.qty, 0);
        expect(res.expectedQty).toBe(expected);
        expect(res.soldQty).toBe(expected - c.phys - totalLoss);
        expect(res.soldQty).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Invariant I2: opening_value + in_cost = COGS + own_loss_cost + closing_value', () => {
    it('holds across various costs, quantities, and repeating fraction ratios', () => {
      const cases = [
        // Clean whole numbers
        { opQty: 4, opVal: '8000', inQty: 6, inCost: '15000', phys: 3, sold: 6, loss: 1 },
        // Zero opening
        { opQty: 0, opVal: '0', inQty: 10, inCost: '10000', phys: 3, sold: 7, loss: 0 },
        // Repeating fractions: total cost 10.000 with 3 pcs total -> avg_cost 3333.333333...
        { opQty: 1, opVal: '3333.3333', inQty: 2, inCost: '6666.6667', phys: 1, sold: 1, loss: 1 },
        // High numbers (e.g. 50.000.000)
        { opQty: 100, opVal: '20000000', inQty: 150, inCost: '30000000', phys: 50, sold: 180, loss: 20 },
      ];

      for (const c of cases) {
        const costing = calculateOwnCosting({
          openingQty: c.opQty,
          openingValue: c.opVal,
          inQty: c.inQty,
          inCost: c.inCost,
          physicalQty: c.phys,
          soldQty: c.sold,
          lossQty: c.loss,
        });

        const totalIn = addMoney(c.opVal, c.inCost);
        const totalOut = costing.cogs.plus(costing.ownLossCost).plus(costing.closingValue);

        // High precision Decimal difference should be 0 (or within 10^-20 due to repeating division)
        const diff = totalIn.minus(totalOut).abs();
        expect(diff.lte(parseMoney('0.0001'))).toBe(true);
      }
    });
  });

  describe('Invariant I3: B - A = (R - T) + (opening_value_total - closing_value_total)', () => {
    it('holds strictly across various combinations of own, consignor, exact, short, and excess cash', () => {
      const scenarios = [
        { qris: '60000', cash: '28000', modal: '15000' }, // exact cash
        { qris: '60000', cash: '25000', modal: '15000' }, // short cash -3000
        { qris: '60000', cash: '35000', modal: '15000' }, // excess cash +7000
        { qris: '0', cash: '0', modal: '15000' }, // zero revenue
      ];

      for (const sc of scenarios) {
        const ownProduct = calculateOpnameProduct({
          productId: 'own-1',
          ownerType: 'own',
          sellPrice: '3000',
          openingQty: 4,
          openingValue: '8000',
          inQty: 6,
          inCost: '15000',
          physicalQty: 3,
          losses: [{ qty: 1, reason: 'lost', borneBy: 'owner' }],
        });

        const consignorProduct = calculateOpnameProduct({
          productId: 'cons-1',
          ownerType: 'consignor',
          consignorId: 'c-1',
          sellPrice: '7000',
          marginScheme: { type: 'nominal', marginValue: '1000' },
          openingQty: 0,
          inQty: 10,
          physicalQty: 0,
        });

        const rec = calculateReconciliation({
          products: [ownProduct, consignorProduct],
          qrisAmount: sc.qris,
          cashAmount: sc.cash,
          modalBelanjaOwn: sc.modal,
        });

        expect(rec.invariantI3Satisfied).toBe(true);

        // Direct check: profitDiff === cashDiff + (openingVal - closingVal)
        const expectedDiff = rec.cashDifference.plus(rec.totalOpeningValue.minus(rec.totalClosingValue));
        expect(rec.profitDiff.toString()).toBe(expectedDiff.toString());
      }
    });
  });

  describe('Invariant I4: saldo_penitip = sum(accrual) - sum(payment)', () => {
    it('holds for arbitrary lists of accruals and payments', () => {
      const accruals = ['15000.5000', '25000', '10000.7500'];
      const payments = ['20000', '15000'];

      const summary = calculateConsignorLedger('c-test', accruals, payments);

      const totalAccrual = parseMoney('15000.5000').plus('25000').plus('10000.7500');
      const totalPayment = parseMoney('20000').plus('15000');
      const expectedBalance = totalAccrual.minus(totalPayment);

      expect(summary.totalAccrual.toString()).toBe(totalAccrual.toString());
      expect(summary.totalPayment.toString()).toBe(totalPayment.toString());
      expect(summary.balance.toString()).toBe(expectedBalance.toString());
      expect(summary.status).toBe('unpaid');
    });
  });

  describe('Invariant I5: for consignor products, sold_share + margin_owner = T_consignor', () => {
    it('holds for nominal margin schemes', () => {
      const margin = calculateConsignorMargin('7000', { type: 'nominal', marginValue: '1000' });
      const soldQty = 14;

      const soldShare = mulMoney(margin.consignorSharePerPcs, soldQty.toString());
      const ownerMargin = mulMoney(margin.ownerMarginPerPcs, soldQty.toString());
      const theoreticalTurnover = mulMoney('7000', soldQty.toString());

      expect(soldShare.plus(ownerMargin).toString()).toBe(theoreticalTurnover.toString());
    });

    it('holds for percent margin schemes with unrounded decimals (G11)', () => {
      const margin = calculateConsignorMargin('7777', { type: 'percent', marginPercentage: '3.65' });
      const soldQty = 3;

      const soldShare = mulMoney(margin.consignorSharePerPcs, soldQty.toString());
      const ownerMargin = mulMoney(margin.ownerMarginPerPcs, soldQty.toString());
      const theoreticalTurnover = mulMoney('7777', soldQty.toString());

      expect(soldShare.plus(ownerMargin).toString()).toBe(theoreticalTurnover.toString());
    });
  });
});
