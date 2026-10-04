import { describe, expect, it } from 'vitest';
import { InvalidMoneyError } from '../../../src/domain/errors.js';
import { calculateOpnameProduct } from '../../../src/domain/opname.js';
import {
  calculateConsignorLedger,
  calculateConsignorPayouts,
} from '../../../src/domain/payout.js';

describe('domain/payout', () => {
  describe('calculateConsignorPayouts', () => {
    it('aggregates multiple products for the same consignor and ignores own products', () => {
      const ownProduct = calculateOpnameProduct({
        productId: 'own-1',
        ownerType: 'own',
        openingQty: 0,
        inQty: 10,
        physicalQty: 5,
        sellPrice: '2000',
      });

      const saniProd1 = calculateOpnameProduct({
        productId: 'sani-1',
        ownerType: 'consignor',
        consignorId: 'c-sani',
        openingQty: 0,
        inQty: 10,
        physicalQty: 0,
        sellPrice: '7000',
        marginScheme: { type: 'nominal', marginValue: '1000' },
      }); // payout 60.000

      const saniProd2 = calculateOpnameProduct({
        productId: 'sani-2',
        ownerType: 'consignor',
        consignorId: 'c-sani',
        openingQty: 0,
        inQty: 5,
        physicalQty: 1,
        losses: [{ qty: 1, reason: 'damaged_on_display', borneBy: 'owner' }],
        sellPrice: '5000',
        marginScheme: { type: 'nominal', marginValue: '1000' },
      }); // sold 3 @ 4000 = 12000, loss comp 1 @ 4000 = 4000 -> payout 16.000

      const pejaProd = calculateOpnameProduct({
        productId: 'peja-1',
        ownerType: 'consignor',
        consignorId: 'c-peja',
        openingQty: 0,
        inQty: 20,
        physicalQty: 0,
        sellPrice: '10000',
        marginScheme: { type: 'percent', marginPercentage: '3.65' },
      }); // payout 192.700

      const payoutMap = calculateConsignorPayouts([
        ownProduct,
        saniProd1,
        saniProd2,
        pejaProd,
      ]);

      expect(payoutMap.size).toBe(2);

      const saniPayout = payoutMap.get('c-sani')!;
      expect(saniPayout.soldShare.toString()).toBe('72000'); // 60000 + 12000
      expect(saniPayout.lossCompensation.toString()).toBe('4000');
      expect(saniPayout.payoutDue.toString()).toBe('76000');
      expect(saniPayout.products.length).toBe(2);

      const pejaPayout = payoutMap.get('c-peja')!;
      expect(pejaPayout.payoutDue.toString()).toBe('192700');
    });
  });

  describe('calculateConsignorLedger (G9 baseline)', () => {
    it('calculates ledger progression through unpaid, settled, and overpaid states', () => {
      // Step 1: Accrual 60.000 (from G2)
      const step1 = calculateConsignorLedger('c-sani', ['60000'], []);
      expect(step1.totalAccrual.toString()).toBe('60000');
      expect(step1.totalPayment.toString()).toBe('0');
      expect(step1.balance.toString()).toBe('60000');
      expect(step1.status).toBe('unpaid');

      // Step 2: Pay 40.000
      const step2 = calculateConsignorLedger('c-sani', ['60000'], ['40000']);
      expect(step2.totalPayment.toString()).toBe('40000');
      expect(step2.balance.toString()).toBe('20000');
      expect(step2.status).toBe('unpaid');

      // Step 3: Pay another 20.000 (total paid 60.000)
      const step3 = calculateConsignorLedger('c-sani', ['60000'], ['40000', '20000']);
      expect(step3.totalPayment.toString()).toBe('60000');
      expect(step3.balance.toString()).toBe('0');
      expect(step3.status).toBe('settled');

      // Step 4: Pay another 5.000 (total paid 65.000) -> overpaid
      const step4 = calculateConsignorLedger(
        'c-sani',
        ['60000'],
        ['40000', '20000', '5000'],
      );
      expect(step4.totalPayment.toString()).toBe('65000');
      expect(step4.balance.toString()).toBe('-5000');
      expect(step4.status).toBe('overpaid');

      // Invariant I4: balance === totalAccrual - totalPayment
      expect(step4.balance.toString()).toBe(
        step4.totalAccrual.minus(step4.totalPayment).toString(),
      );
    });

    it('rejects negative accruals', () => {
      expect(() => calculateConsignorLedger('c-1', ['-1000'], [])).toThrow(
        InvalidMoneyError,
      );
    });

    it('rejects non-positive payments (payment <= 0)', () => {
      expect(() => calculateConsignorLedger('c-1', ['1000'], ['0'])).toThrow(
        InvalidMoneyError,
      );
      expect(() => calculateConsignorLedger('c-1', ['1000'], ['-500'])).toThrow(
        InvalidMoneyError,
      );
    });
  });
});
