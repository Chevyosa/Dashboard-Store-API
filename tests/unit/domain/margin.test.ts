import { describe, expect, it } from 'vitest';
import {
  InvalidMarginError,
  InvalidPercentageError,
  InvalidQuantityError,
} from '../../../src/domain/errors.js';
import {
  calculateConsignorMargin,
  calculateOwnMargin,
} from '../../../src/domain/margin.js';

describe('domain/margin', () => {
  describe('calculateOwnMargin', () => {
    it('calculates margin per pcs and per pack accurately (G1 baseline)', () => {
      // G1: Gery Salut: sell 1.500, avg_cost 1.000, 10 pcs/pack
      const result = calculateOwnMargin('1500', '1000', 10);
      expect(result.marginPerPcs.toString()).toBe('500');
      expect(result.marginPerPack.toString()).toBe('5000');
      expect(result.sellPrice.toString()).toBe('1500');
      expect(result.avgCost.toString()).toBe('1000');
      expect(result.pcsPerPack).toBe(10);
    });

    it('defaults pcsPerPack to 1', () => {
      const result = calculateOwnMargin('5000', '3500');
      expect(result.marginPerPcs.toString()).toBe('1500');
      expect(result.marginPerPack.toString()).toBe('1500');
      expect(result.pcsPerPack).toBe(1);
    });

    it('allows negative margin if sellPrice < avgCost (selling at loss)', () => {
      const result = calculateOwnMargin('800', '1000', 1);
      expect(result.marginPerPcs.toString()).toBe('-200');
    });

    it('throws when pcsPerPack is not an integer or < 1', () => {
      expect(() => calculateOwnMargin('1000', '500', 0)).toThrow(InvalidQuantityError);
      expect(() => calculateOwnMargin('1000', '500', -2)).toThrow(InvalidQuantityError);
      expect(() => calculateOwnMargin('1000', '500', 1.5)).toThrow(InvalidQuantityError);
    });

    it('throws when sellPrice or avgCost is negative', () => {
      expect(() => calculateOwnMargin('-1000', '500')).toThrow(InvalidMarginError);
      expect(() => calculateOwnMargin('1000', '-500')).toThrow(InvalidMarginError);
    });
  });

  describe('calculateConsignorMargin', () => {
    describe('nominal scheme', () => {
      it('calculates nominal margin and consignor share (G2 baseline - Pak Sani)', () => {
        // G2: sell 7.000, margin 1.000 -> share 6.000
        const result = calculateConsignorMargin('7000', {
          type: 'nominal',
          marginValue: '1000',
        });
        expect(result.ownerMarginPerPcs.toString()).toBe('1000');
        expect(result.consignorSharePerPcs.toString()).toBe('6000');
        // Invariant I5
        expect(result.ownerMarginPerPcs.plus(result.consignorSharePerPcs).toString()).toBe('7000');
      });

      it('allows marginValue of 0 (owner earns 0 margin, consignor gets 100%)', () => {
        const result = calculateConsignorMargin('5000', {
          type: 'nominal',
          marginValue: '0',
        });
        expect(result.ownerMarginPerPcs.toString()).toBe('0');
        expect(result.consignorSharePerPcs.toString()).toBe('5000');
      });

      it('rejects negative margin value', () => {
        expect(() =>
          calculateConsignorMargin('7000', {
            type: 'nominal',
            marginValue: '-100',
          }),
        ).toThrow(InvalidMarginError);
      });

      it('rejects margin value greater than or equal to sellPrice', () => {
        expect(() =>
          calculateConsignorMargin('7000', {
            type: 'nominal',
            marginValue: '7000',
          }),
        ).toThrow(InvalidMarginError);
        expect(() =>
          calculateConsignorMargin('7000', {
            type: 'nominal',
            marginValue: '8000',
          }),
        ).toThrow(InvalidMarginError);
      });
    });

    describe('percent scheme', () => {
      it('calculates percent margin and consignor share (G3 baseline - Kak Peja)', () => {
        // G3: sell 10.000, pct 3.65 -> margin 365, share 9.635
        const result = calculateConsignorMargin('10000', {
          type: 'percent',
          marginPercentage: '3.65',
        });
        expect(result.ownerMarginPerPcs.toString()).toBe('365');
        expect(result.consignorSharePerPcs.toString()).toBe('9635');
        // Invariant I5
        expect(result.ownerMarginPerPcs.plus(result.consignorSharePerPcs).toString()).toBe('10000');
      });

      it('calculates unrounded percent values with full precision (G11 baseline)', () => {
        // G11: sell 7.777, pct 3.65 -> margin 283.8605, share 7493.1395
        const result = calculateConsignorMargin('7777', {
          type: 'percent',
          marginPercentage: '3.65',
        });
        expect(result.ownerMarginPerPcs.toString()).toBe('283.8605');
        expect(result.consignorSharePerPcs.toString()).toBe('7493.1395');
        // Invariant I5
        expect(result.ownerMarginPerPcs.plus(result.consignorSharePerPcs).toString()).toBe('7777');
      });

      it('rejects pct <= 0 or pct >= 100 per BR-03', () => {
        expect(() =>
          calculateConsignorMargin('10000', {
            type: 'percent',
            marginPercentage: '0',
          }),
        ).toThrow(InvalidPercentageError);
        expect(() =>
          calculateConsignorMargin('10000', {
            type: 'percent',
            marginPercentage: '-5',
          }),
        ).toThrow(InvalidPercentageError);
        expect(() =>
          calculateConsignorMargin('10000', {
            type: 'percent',
            marginPercentage: '100',
          }),
        ).toThrow(InvalidPercentageError);
        expect(() =>
          calculateConsignorMargin('10000', {
            type: 'percent',
            marginPercentage: '105',
          }),
        ).toThrow(InvalidPercentageError);
      });
    });

    it('rejects sellPrice <= 0 for consignor products', () => {
      expect(() =>
        calculateConsignorMargin('0', {
          type: 'nominal',
          marginValue: '0',
        }),
      ).toThrow(InvalidMarginError);
      expect(() =>
        calculateConsignorMargin('-5000', {
          type: 'nominal',
          marginValue: '1000',
        }),
      ).toThrow(InvalidMarginError);
    });

    it('rejects invalid scheme types', () => {
      expect(() =>
        calculateConsignorMargin('5000', {
          // @ts-expect-error - testing invalid scheme type
          type: 'unknown',
        }),
      ).toThrow(InvalidMarginError);
    });
  });
});
