import { describe, expect, it } from 'vitest';
import {
  InvalidLossBorneByError,
  InvalidQuantityError,
  LossExceedsDiffStockError,
  NegativeDiffStockError,
} from '../../../src/domain/errors.js';
import {
  calculateOpnameProduct,
  getDefaultLossBorneBy,
} from '../../../src/domain/opname.js';

describe('domain/opname', () => {
  describe('getDefaultLossBorneBy', () => {
    it('always returns "owner" for own products regardless of reason', () => {
      expect(getDefaultLossBorneBy('own', 'expired')).toBe('owner');
      expect(getDefaultLossBorneBy('own', 'damaged_on_display')).toBe('owner');
      expect(getDefaultLossBorneBy('own', 'damaged_before_display')).toBe('owner');
      expect(getDefaultLossBorneBy('own', 'lost')).toBe('owner');
      expect(getDefaultLossBorneBy('own', 'other')).toBe('owner');
    });

    it('returns default borne_by for consignor products per §5.6 table', () => {
      expect(getDefaultLossBorneBy('consignor', 'expired')).toBe('consignor');
      expect(getDefaultLossBorneBy('consignor', 'damaged_before_display')).toBe('consignor');
      expect(getDefaultLossBorneBy('consignor', 'damaged_on_display')).toBe('owner');
      expect(getDefaultLossBorneBy('consignor', 'lost')).toBe('owner');
      expect(getDefaultLossBorneBy('consignor', 'other')).toBe('owner');
    });
  });

  describe('calculateOpnameProduct', () => {
    it('calculates own product opname (G1 baseline - Gery Salut)', () => {
      const res = calculateOpnameProduct({
        productId: 'prod-1',
        ownerType: 'own',
        openingQty: 0,
        openingValue: '0',
        inQty: 10,
        inCost: '10000',
        physicalQty: 3,
        sellPrice: '1500',
        pcsPerPack: 10,
      });

      expect(res.expectedQty).toBe(10);
      expect(res.diffQty).toBe(7);
      expect(res.lossQty).toBe(0);
      expect(res.soldQty).toBe(7);
      expect(res.turnover.toString()).toBe('10500');
      expect(res.costing?.avgCost.toString()).toBe('1000');
      expect(res.costing?.cogs.toString()).toBe('7000');
      expect(res.marginTotalOwn?.toString()).toBe('3500');
      expect(res.costing?.closingValue.toString()).toBe('3000');
    });

    it('calculates consignor nominal product opname (G2 baseline - Pak Sani)', () => {
      const res = calculateOpnameProduct({
        productId: 'prod-2',
        ownerType: 'consignor',
        consignorId: 'c-sani',
        openingQty: 0,
        inQty: 10,
        physicalQty: 0,
        sellPrice: '7000',
        marginScheme: { type: 'nominal', marginValue: '1000' },
      });

      expect(res.expectedQty).toBe(10);
      expect(res.diffQty).toBe(10);
      expect(res.soldQty).toBe(10);
      expect(res.turnover.toString()).toBe('70000');
      expect(res.ownerMarginTotalConsignor?.toString()).toBe('10000');
      expect(res.payoutDue?.toString()).toBe('60000');
    });

    it('calculates consignor percent product opname (G3 baseline - Kak Peja)', () => {
      const res = calculateOpnameProduct({
        productId: 'prod-3',
        ownerType: 'consignor',
        consignorId: 'c-peja',
        openingQty: 0,
        inQty: 20,
        physicalQty: 0,
        sellPrice: '10000',
        marginScheme: { type: 'percent', marginPercentage: '3.65' },
      });

      expect(res.soldQty).toBe(20);
      expect(res.turnover.toString()).toBe('200000');
      expect(res.ownerMarginTotalConsignor?.toString()).toBe('7300');
      expect(res.payoutDue?.toString()).toBe('192700');
    });

    it('calculates consignor loss borne by owner with compensation (G4 baseline)', () => {
      const res = calculateOpnameProduct({
        productId: 'prod-2',
        ownerType: 'consignor',
        consignorId: 'c-sani',
        openingQty: 0,
        inQty: 10,
        physicalQty: 2,
        losses: [{ qty: 1, reason: 'damaged_on_display', borneBy: 'owner' }],
        sellPrice: '7000',
        marginScheme: { type: 'nominal', marginValue: '1000' },
      });

      expect(res.diffQty).toBe(8);
      expect(res.lossQty).toBe(1);
      expect(res.soldQty).toBe(7);
      expect(res.turnover.toString()).toBe('49000');
      expect(res.soldShare?.toString()).toBe('42000');
      expect(res.lossCompensation?.toString()).toBe('6000');
      expect(res.payoutDue?.toString()).toBe('48000');
      expect(res.ownerMarginTotalConsignor?.toString()).toBe('7000');
    });

    it('calculates consignor loss borne by consignor without compensation (G5 baseline)', () => {
      const res = calculateOpnameProduct({
        productId: 'prod-2',
        ownerType: 'consignor',
        consignorId: 'c-sani',
        openingQty: 0,
        inQty: 10,
        physicalQty: 2,
        losses: [{ qty: 1, reason: 'expired', borneBy: 'consignor' }],
        sellPrice: '7000',
        marginScheme: { type: 'nominal', marginValue: '1000' },
      });

      expect(res.diffQty).toBe(8);
      expect(res.lossQty).toBe(1);
      expect(res.soldQty).toBe(7);
      expect(res.turnover.toString()).toBe('49000');
      expect(res.soldShare?.toString()).toBe('42000');
      expect(res.lossCompensation?.toString()).toBe('0');
      expect(res.payoutDue?.toString()).toBe('42000');
      expect(res.ownerMarginTotalConsignor?.toString()).toBe('7000');
    });

    it('calculates consignor percent loss borne by owner (G10 baseline)', () => {
      const res = calculateOpnameProduct({
        productId: 'prod-3',
        ownerType: 'consignor',
        consignorId: 'c-peja',
        openingQty: 0,
        inQty: 20,
        physicalQty: 5,
        losses: [{ qty: 1, reason: 'damaged_on_display', borneBy: 'owner' }],
        sellPrice: '10000',
        marginScheme: { type: 'percent', marginPercentage: '3.65' },
      });

      expect(res.diffQty).toBe(15);
      expect(res.soldQty).toBe(14);
      expect(res.turnover.toString()).toBe('140000');
      expect(res.ownerMarginPerPcsConsignor?.toString()).toBe('365');
      expect(res.ownerMarginTotalConsignor?.toString()).toBe('5110');
      expect(res.consignorSharePerPcs?.toString()).toBe('9635');
      expect(res.soldShare?.toString()).toBe('134890');
      expect(res.lossCompensation?.toString()).toBe('9635');
      expect(res.payoutDue?.toString()).toBe('144525');
    });

    it('deducts returnedQty for consignor products', () => {
      const res = calculateOpnameProduct({
        productId: 'prod-consignor',
        ownerType: 'consignor',
        consignorId: 'c-1',
        openingQty: 5,
        inQty: 10,
        returnedQty: 3, // return 3 pcs
        physicalQty: 2,
        sellPrice: '5000',
        marginScheme: { type: 'nominal', marginValue: '1000' },
      });

      // expected = 5 + 10 - 3 = 12. diff = 12 - 2 = 10
      expect(res.expectedQty).toBe(12);
      expect(res.diffQty).toBe(10);
      expect(res.soldQty).toBe(10);
    });

    it('throws NegativeDiffStockError when physicalQty > expectedQty', () => {
      expect(() =>
        calculateOpnameProduct({
          productId: 'p-1',
          ownerType: 'own',
          openingQty: 5,
          inQty: 5,
          physicalQty: 12, // expected 10, physical 12
          sellPrice: '1000',
        }),
      ).toThrow(NegativeDiffStockError);
    });

    it('throws LossExceedsDiffStockError when lossQty > diffQty', () => {
      expect(() =>
        calculateOpnameProduct({
          productId: 'p-1',
          ownerType: 'own',
          openingQty: 5,
          inQty: 5,
          physicalQty: 7, // diff = 3
          losses: [{ qty: 4, reason: 'lost', borneBy: 'owner' }],
          sellPrice: '1000',
        }),
      ).toThrow(LossExceedsDiffStockError);
    });

    it('throws InvalidLossBorneByError when own product loss is borne by consignor', () => {
      expect(() =>
        calculateOpnameProduct({
          productId: 'p-1',
          ownerType: 'own',
          openingQty: 5,
          inQty: 5,
          physicalQty: 5,
          losses: [{ qty: 1, reason: 'lost', borneBy: 'consignor' }],
          sellPrice: '1000',
        }),
      ).toThrow(InvalidLossBorneByError);
    });

    it('throws InvalidQuantityError when own product has returnedQty > 0', () => {
      expect(() =>
        calculateOpnameProduct({
          productId: 'p-1',
          ownerType: 'own',
          openingQty: 5,
          inQty: 5,
          returnedQty: 1,
          physicalQty: 5,
          sellPrice: '1000',
        }),
      ).toThrow(InvalidQuantityError);
    });

    it('throws InvalidQuantityError when returnedQty exceeds opening + in (negative expectedQty)', () => {
      expect(() =>
        calculateOpnameProduct({
          productId: 'p-1',
          ownerType: 'consignor',
          consignorId: 'c-1',
          openingQty: 2,
          inQty: 3,
          returnedQty: 10,
          physicalQty: 0,
          sellPrice: '1000',
          marginScheme: { type: 'nominal', marginValue: '100' },
        }),
      ).toThrow(InvalidQuantityError);
    });

    it('throws error when consignor product is missing marginScheme', () => {
      expect(() =>
        calculateOpnameProduct({
          productId: 'p-1',
          ownerType: 'consignor',
          consignorId: 'c-1',
          openingQty: 5,
          inQty: 5,
          physicalQty: 5,
          sellPrice: '1000',
        }),
      ).toThrow('Skema margin wajib diisi untuk produk titipan');
    });

    it('validates integer and non-negative quantities', () => {
      const base = {
        productId: 'p-1',
        ownerType: 'own' as const,
        sellPrice: '1000',
      };
      expect(() =>
        calculateOpnameProduct({ ...base, openingQty: -1, inQty: 0, physicalQty: 0 }),
      ).toThrow(InvalidQuantityError);
      expect(() =>
        calculateOpnameProduct({ ...base, openingQty: 0, inQty: -1, physicalQty: 0 }),
      ).toThrow(InvalidQuantityError);
      expect(() =>
        calculateOpnameProduct({
          ...base,
          openingQty: 0,
          inQty: 0,
          returnedQty: -1,
          physicalQty: 0,
        }),
      ).toThrow(InvalidQuantityError);
      expect(() =>
        calculateOpnameProduct({ ...base, openingQty: 0, inQty: 0, physicalQty: -1 }),
      ).toThrow(InvalidQuantityError);
      expect(() =>
        calculateOpnameProduct({
          ...base,
          openingQty: 0,
          inQty: 5,
          physicalQty: 0,
          losses: [{ qty: 0, reason: 'lost', borneBy: 'owner' }],
        }),
      ).toThrow(InvalidQuantityError);
    });
  });
});
