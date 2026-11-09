import { describe, expect, it } from 'vitest';
import { InvalidMoneyError } from '../../../src/domain/errors.js';
import { parseMoney } from '../../../src/domain/money.js';
import { calculateOpnameProduct } from '../../../src/domain/opname.js';
import { calculateReconciliation } from '../../../src/domain/profit.js';

describe('domain/profit', () => {
  // Helper to build G7/G8 opname products (G6 Own + G2 Titipan)
  function createG7Products() {
    const g6Product = calculateOpnameProduct({
      productId: 'prod-own-g6',
      ownerType: 'own',
      openingQty: 4,
      openingValue: '8000',
      inQty: 6,
      inCost: '15000',
      physicalQty: 3,
      losses: [{ qty: 1, reason: 'lost', borneBy: 'owner' }],
      sellPrice: '3000',
    });

    const g2Product = calculateOpnameProduct({
      productId: 'prod-consignor-g2',
      ownerType: 'consignor',
      consignorId: 'c-sani',
      openingQty: 0,
      inQty: 10,
      physicalQty: 0,
      sellPrice: '7000',
      marginScheme: { type: 'nominal', marginValue: '1000' },
    });

    return [g6Product, g2Product];
  }

  describe('calculateReconciliation', () => {
    it('calculates reconciliation for G7 baseline (exact cash match)', () => {
      const products = createG7Products();
      // G7: QRIS 60.000 + cash 28.000; modal belanja 15.000
      const rec = calculateReconciliation({
        products,
        qrisAmount: '60000',
        cashAmount: '28000',
        modalBelanjaOwn: '15000',
      });

      expect(rec.theoreticalTurnover.toString()).toBe('88000'); // T = 18.000 + 70.000
      expect(rec.realCash.toString()).toBe('88000'); // R = 88.000
      expect(rec.cashDifference.toString()).toBe('0');
      expect(rec.cashDifferenceHint).toContain('cocok');
      expect(rec.totalPayoutDue.toString()).toBe('60000');

      // Profit A = (T_own - COGS) + Titipan_margin - own_loss - loss_comp
      // = (18.000 - 13.800) + 10.000 - 2.300 - 0 = 4.200 + 10.000 - 2.300 = 11.900
      expect(rec.profitA.toString()).toBe('11900');

      // Profit B = R - payout - modal_belanja = 88.000 - 60.000 - 15.000 = 13.000
      expect(rec.profitB.toString()).toBe('13000');

      // B - A = 13.000 - 11.900 = 1.100 = 8.000 - 6.900 (stock value change)
      expect(rec.profitDiff.toString()).toBe('1100');
      expect(rec.invariantI3Satisfied).toBe(true);
    });

    it('calculates reconciliation for G8 baseline (short cash)', () => {
      const products = createG7Products();
      // G8: QRIS 60.000 + cash 25.000; modal belanja 15.000
      const rec = calculateReconciliation({
        products,
        qrisAmount: '60000',
        cashAmount: '25000',
        modalBelanjaOwn: '15000',
      });

      expect(rec.theoreticalTurnover.toString()).toBe('88000');
      expect(rec.realCash.toString()).toBe('85000');
      expect(rec.cashDifference.toString()).toBe('-3000');
      expect(rec.cashDifferenceHint).toContain('Kekurangan uang riil sebesar Rp 3.000');

      // Profit A remains identical (goods-based) = 11.900
      expect(rec.profitA.toString()).toBe('11900');

      // Profit B = 85.000 - 60.000 - 15.000 = 10.000
      expect(rec.profitB.toString()).toBe('10000');

      // B - A = 10.000 - 11.900 = -1.900 = -3.000 + 1.100
      expect(rec.profitDiff.toString()).toBe('-1900');
      expect(rec.invariantI3Satisfied).toBe(true);
    });

    it('generates over-cash hint when real cash exceeds turnover', () => {
      const products = createG7Products();
      const rec = calculateReconciliation({
        products,
        qrisAmount: '60000',
        cashAmount: '30000', // R = 90.000 (+2.000)
        modalBelanjaOwn: '15000',
      });

      expect(rec.cashDifference.toString()).toBe('2000');
      expect(rec.cashDifferenceHint).toContain('Kelebihan uang riil sebesar Rp 2.000');
      expect(rec.invariantI3Satisfied).toBe(true);
    });

    it('rejects negative amounts for QRIS, cash, or modal belanja', () => {
      const products = createG7Products();
      expect(() =>
        calculateReconciliation({
          products,
          qrisAmount: '-100',
          cashAmount: '1000',
          modalBelanjaOwn: '1000',
        }),
      ).toThrow(InvalidMoneyError);

      expect(() =>
        calculateReconciliation({
          products,
          qrisAmount: '1000',
          cashAmount: '-100',
          modalBelanjaOwn: '1000',
        }),
      ).toThrow(InvalidMoneyError);

      expect(() =>
        calculateReconciliation({
          products,
          qrisAmount: '1000',
          cashAmount: '1000',
          modalBelanjaOwn: '-100',
        }),
      ).toThrow(InvalidMoneyError);
    });

    it('handles products without optional fields gracefully', () => {
      const incompleteOwnProduct = {
        productId: 'own-no-costing',
        ownerType: 'own' as const,
        consignorId: null,
        openingQty: 0,
        inQty: 0,
        returnedQty: 0,
        expectedQty: 0,
        physicalQty: 0,
        diffQty: 0,
        lossQty: 0,
        soldQty: 0,
        sellPrice: parseMoney('1000'),
        turnover: parseMoney('0'),
      };

      const incompleteConsignorProduct = {
        productId: 'cons-no-margin',
        ownerType: 'consignor' as const,
        consignorId: 'c-test',
        openingQty: 0,
        inQty: 0,
        returnedQty: 0,
        expectedQty: 0,
        physicalQty: 0,
        diffQty: 0,
        lossQty: 0,
        soldQty: 0,
        sellPrice: parseMoney('2000'),
        turnover: parseMoney('0'),
      };

      const rec = calculateReconciliation({
        products: [incompleteOwnProduct, incompleteConsignorProduct],
        qrisAmount: '0',
        cashAmount: '0',
        modalBelanjaOwn: '0',
      });

      expect(rec.theoreticalTurnover.toString()).toBe('0');
      expect(rec.profitA.toString()).toBe('0');
      expect(rec.profitB.toString()).toBe('0');
    });
  });
});
