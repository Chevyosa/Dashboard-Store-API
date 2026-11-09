import { describe, expect, it } from 'vitest';
import { InvalidMoneyError, InvalidQuantityError } from '../../../src/domain/errors.js';
import {
  calculateOwnCosting,
  calculatePeriodicAvgCost,
} from '../../../src/domain/costing.js';

describe('domain/costing', () => {
  describe('calculatePeriodicAvgCost', () => {
    it('calculates weighted average cost accurately (G6 baseline)', () => {
      // G6: opening 4 pcs @ 8.000, in 6 pcs @ 15.000 -> total 10 pcs, 23.000 -> avg 2.300
      const avgCost = calculatePeriodicAvgCost(4, '8000', 6, '15000');
      expect(avgCost.toString()).toBe('2300');
    });

    it('calculates avg cost when opening is zero (G1 baseline)', () => {
      // G1: opening 0, in 10 pcs @ 10.000 -> avg 1.000
      const avgCost = calculatePeriodicAvgCost(0, '0', 10, '10000');
      expect(avgCost.toString()).toBe('1000');
    });

    it('returns zero when totalQty is zero without dividing by zero error', () => {
      const avgCost = calculatePeriodicAvgCost(0, '0', 0, '0');
      expect(avgCost.toString()).toBe('0');
    });

    it('handles opening stock only (inQty is zero)', () => {
      const avgCost = calculatePeriodicAvgCost(5, '25000', 0, '0');
      expect(avgCost.toString()).toBe('5000');
    });

    it('throws when quantities are negative or non-integers', () => {
      expect(() => calculatePeriodicAvgCost(-1, '1000', 5, '5000')).toThrow(InvalidQuantityError);
      expect(() => calculatePeriodicAvgCost(2.5, '1000', 5, '5000')).toThrow(InvalidQuantityError);
      expect(() => calculatePeriodicAvgCost(5, '1000', -2, '5000')).toThrow(InvalidQuantityError);
      expect(() => calculatePeriodicAvgCost(5, '1000', 1.2, '5000')).toThrow(InvalidQuantityError);
    });

    it('throws when values are negative', () => {
      expect(() => calculatePeriodicAvgCost(5, '-1000', 5, '5000')).toThrow(InvalidMoneyError);
      expect(() => calculatePeriodicAvgCost(5, '1000', 5, '-5000')).toThrow(InvalidMoneyError);
    });
  });

  describe('calculateOwnCosting & Invariant I2', () => {
    it('calculates costing for G1 scenario', () => {
      // G1: in 10 @ 10.000, physical 3, sold 7, loss 0
      const result = calculateOwnCosting({
        openingQty: 0,
        openingValue: '0',
        inQty: 10,
        inCost: '10000',
        physicalQty: 3,
        soldQty: 7,
        lossQty: 0,
      });

      expect(result.avgCost.toString()).toBe('1000');
      expect(result.cogs.toString()).toBe('7000');
      expect(result.ownLossCost.toString()).toBe('0');
      expect(result.closingValue.toString()).toBe('3000');
      expect(result.totalCost.toString()).toBe('10000');

      // Invariant I2: opening_value + in_cost === COGS + own_loss_cost + closing_value
      const allocated = result.cogs.plus(result.ownLossCost).plus(result.closingValue);
      expect(allocated.toString()).toBe(result.totalCost.toString());
    });

    it('calculates costing for G6 scenario', () => {
      // G6: opening 4 @ 8.000, in 6 @ 15.000, physical 3, loss 1, sold 6
      const result = calculateOwnCosting({
        openingQty: 4,
        openingValue: '8000',
        inQty: 6,
        inCost: '15000',
        physicalQty: 3,
        soldQty: 6,
        lossQty: 1,
      });

      expect(result.avgCost.toString()).toBe('2300');
      expect(result.cogs.toString()).toBe('13800');
      expect(result.ownLossCost.toString()).toBe('2300');
      expect(result.closingValue.toString()).toBe('6900');
      expect(result.totalCost.toString()).toBe('23000');

      // Invariant I2: 23.000 = 13.800 + 2.300 + 6.900
      const allocated = result.cogs.plus(result.ownLossCost).plus(result.closingValue);
      expect(allocated.toString()).toBe('23000');
    });

    it('handles entire stock unsold (physical = totalQty)', () => {
      const result = calculateOwnCosting({
        openingQty: 5,
        openingValue: '10000',
        inQty: 5,
        inCost: '10000',
        physicalQty: 10,
        soldQty: 0,
        lossQty: 0,
      });

      expect(result.avgCost.toString()).toBe('2000');
      expect(result.cogs.toString()).toBe('0');
      expect(result.ownLossCost.toString()).toBe('0');
      expect(result.closingValue.toString()).toBe('20000');
    });

    it('throws on invalid physicalQty, soldQty, or lossQty', () => {
      const base = {
        openingQty: 1,
        openingValue: '1000',
        inQty: 1,
        inCost: '1000',
      };
      expect(() =>
        calculateOwnCosting({ ...base, physicalQty: -1, soldQty: 0, lossQty: 0 }),
      ).toThrow(InvalidQuantityError);
      expect(() =>
        calculateOwnCosting({ ...base, physicalQty: 1, soldQty: -1, lossQty: 0 }),
      ).toThrow(InvalidQuantityError);
      expect(() =>
        calculateOwnCosting({ ...base, physicalQty: 1, soldQty: 0, lossQty: -1 }),
      ).toThrow(InvalidQuantityError);
      expect(() =>
        calculateOwnCosting({ ...base, physicalQty: 1.5, soldQty: 0, lossQty: 0 }),
      ).toThrow(InvalidQuantityError);
    });
  });
});
