import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { InvalidMoneyError } from '../../../src/domain/errors.js';
import { calculateLiquidity, sumUnpaidPerEntity } from '../../../src/domain/liquidity.js';

describe('domain/liquidity', () => {
  describe('calculateLiquidity', () => {
    it('Rp296.000 opening with Rp300.000 reserve: nothing withdrawable, Rp4.000 shortfall', () => {
      const result = calculateLiquidity({
        movements: ['296000'],
        minimumReserve: '300000',
        unpaidObligations: [],
      });

      expect(result.liquidBalance.toString()).toBe('296000');
      expect(result.minimumReserve.toString()).toBe('300000');
      expect(result.unpaidObligations.toString()).toBe('0');
      expect(result.requiredFunds.toString()).toBe('300000');
      expect(result.safeToWithdraw.toString()).toBe('0');
      expect(result.shortfall.toString()).toBe('4000');
    });

    it('sums inflows and outflows into the liquid balance and holds back unpaid obligations', () => {
      // opening 500.000 + sales 250.000 - restock 120.000 - expense 30.000 = 600.000
      const result = calculateLiquidity({
        movements: ['500000', '250000', '-120000', '-30000'],
        minimumReserve: '300000',
        unpaidObligations: ['60000', '40000'],
      });

      expect(result.liquidBalance.toString()).toBe('600000');
      expect(result.unpaidObligations.toString()).toBe('100000');
      expect(result.requiredFunds.toString()).toBe('400000');
      expect(result.safeToWithdraw.toString()).toBe('200000');
      expect(result.shortfall.toString()).toBe('0');
    });

    it('unpaid obligations alone can create a shortfall even when balance exceeds reserve', () => {
      const result = calculateLiquidity({
        movements: ['350000'],
        minimumReserve: '300000',
        unpaidObligations: ['75000'],
      });

      expect(result.safeToWithdraw.toString()).toBe('0');
      expect(result.shortfall.toString()).toBe('25000');
    });

    it('returns zero for both withdrawable and shortfall when balance exactly equals required funds', () => {
      const result = calculateLiquidity({
        movements: ['250000', '100000'],
        minimumReserve: '300000',
        unpaidObligations: ['50000'],
      });

      expect(result.safeToWithdraw.toString()).toBe('0');
      expect(result.shortfall.toString()).toBe('0');
    });

    it('uses exact decimal arithmetic for fractional amounts (no float drift)', () => {
      // 0.1 + 0.2 would be 0.30000000000000004 in JS floats
      const result = calculateLiquidity({
        movements: ['0.1', '0.2', '1000.3333', '-0.0003'],
        minimumReserve: '500.1',
        unpaidObligations: ['0.2', '100.0001'],
      });

      expect(result.liquidBalance.toString()).toBe('1000.633');
      expect(result.unpaidObligations.toString()).toBe('100.2001');
      expect(result.requiredFunds.toString()).toBe('600.3001');
      expect(result.safeToWithdraw.toString()).toBe('400.3329');
      expect(result.shortfall.toString()).toBe('0');
    });

    it('reports exact fractional shortfall', () => {
      const result = calculateLiquidity({
        movements: ['299999.9999'],
        minimumReserve: '300000',
        unpaidObligations: ['0.0001'],
      });

      expect(result.safeToWithdraw.toString()).toBe('0');
      expect(result.shortfall.toString()).toBe('0.0002');
    });

    it('treats a negative liquid balance (overdrawn) as full shortfall', () => {
      const result = calculateLiquidity({
        movements: ['100000', '-150000'],
        minimumReserve: '300000',
        unpaidObligations: ['20000'],
      });

      expect(result.liquidBalance.toString()).toBe('-50000');
      expect(result.safeToWithdraw.toString()).toBe('0');
      expect(result.shortfall.toString()).toBe('370000');
    });

    it('treats an empty ledger as zero balance', () => {
      const result = calculateLiquidity({
        movements: [],
        minimumReserve: '0',
        unpaidObligations: [],
      });

      expect(result.liquidBalance.toString()).toBe('0');
      expect(result.safeToWithdraw.toString()).toBe('0');
      expect(result.shortfall.toString()).toBe('0');
    });

    it('accepts Decimal inputs and returns Decimal outputs', () => {
      const result = calculateLiquidity({
        movements: [new Decimal('400000')],
        minimumReserve: new Decimal('300000'),
        unpaidObligations: [new Decimal('10000')],
      });

      expect(result.safeToWithdraw).toBeInstanceOf(Decimal);
      expect(result.safeToWithdraw.toString()).toBe('90000');
    });

    it('rejects a negative minimum reserve', () => {
      expect(() =>
        calculateLiquidity({
          movements: ['296000'],
          minimumReserve: '-1',
          unpaidObligations: [],
        }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejects a negative unpaid obligation', () => {
      expect(() =>
        calculateLiquidity({
          movements: ['296000'],
          minimumReserve: '300000',
          unpaidObligations: ['10000', '-0.0001'],
        }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejects JS numbers and malformed strings via money utilities', () => {
      expect(() =>
        calculateLiquidity({
          movements: [296000 as unknown as string],
          minimumReserve: '300000',
          unpaidObligations: [],
        }),
      ).toThrow(InvalidMoneyError);

      expect(() =>
        calculateLiquidity({
          movements: ['296000'],
          minimumReserve: '3e5',
          unpaidObligations: [],
        }),
      ).toThrow(InvalidMoneyError);
    });
  });

  describe('sumUnpaidPerEntity', () => {
    it('does not let one entity overpayment cancel another entity debt', () => {
      const result = sumUnpaidPerEntity({
        accrued: new Map([
          ['consignor-a', '100000'],
          ['consignor-b', '50000'],
        ]),
        paid: new Map([
          ['consignor-a', '130000'], // overpaid by 30.000
          ['consignor-b', '0'],
        ]),
      });

      // naive netting would give 20.000; per-entity floor gives 0 + 50.000
      expect(result).toBeInstanceOf(Decimal);
      expect(result.toString()).toBe('50000');
    });

    it('sums partial payments across entities', () => {
      const result = sumUnpaidPerEntity({
        accrued: new Map([
          ['receipt-1', '200000'],
          ['receipt-2', '80000'],
          ['receipt-3', '45000'],
        ]),
        paid: new Map([
          ['receipt-1', '150000'],
          ['receipt-2', '80000'],
        ]),
      });

      // 50.000 + 0 + 45.000
      expect(result.toString()).toBe('95000');
    });

    it('paid-only keys contribute zero unpaid', () => {
      const result = sumUnpaidPerEntity({
        accrued: new Map([['consignor-a', '10000']]),
        paid: new Map([['consignor-ghost', '999999']]),
      });

      expect(result.toString()).toBe('10000');
    });

    it('returns zero for empty maps', () => {
      const result = sumUnpaidPerEntity({ accrued: new Map(), paid: new Map() });
      expect(result.toString()).toBe('0');
    });

    it('uses exact decimal arithmetic and accepts Decimal values', () => {
      const result = sumUnpaidPerEntity({
        accrued: new Map<string, string | Decimal>([
          ['a', '0.3'],
          ['b', new Decimal('1000.0001')],
        ]),
        paid: new Map<string, string | Decimal>([
          ['a', '0.1'],
          ['b', new Decimal('0.0002')],
        ]),
      });

      // 0.2 + 999.9999
      expect(result.toString()).toBe('1000.1999');
    });

    it('rejects a negative accrued amount', () => {
      expect(() =>
        sumUnpaidPerEntity({
          accrued: new Map([['a', '-0.0001']]),
          paid: new Map(),
        }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejects a negative paid amount, including on paid-only keys', () => {
      expect(() =>
        sumUnpaidPerEntity({
          accrued: new Map([['a', '100']]),
          paid: new Map([['a', '-1']]),
        }),
      ).toThrow(InvalidMoneyError);

      expect(() =>
        sumUnpaidPerEntity({
          accrued: new Map([['a', '100']]),
          paid: new Map([['ghost', '-1']]),
        }),
      ).toThrow(InvalidMoneyError);
    });
  });
});
