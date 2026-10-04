import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { calculateOpnameProduct, type LossItem } from '../../../src/domain/opname.js';
import { calculateConsignorLedger } from '../../../src/domain/payout.js';
import { calculateReconciliation } from '../../../src/domain/profit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/golden');

function loadFixture<T>(filename: string): T {
  const content = fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
  return JSON.parse(content) as T;
}

describe('Golden Scenarios (AGENTS.md §6)', () => {
  it('G1: Own + pack (Gery Salut)', () => {
    interface G1Fixture {
      product: {
        productId: string;
        ownerType: 'own';
        sellPrice: string;
        pcsPerPack: number;
        openingQty: number;
        openingValue: string;
        inQty: number;
        inCost: string;
        physicalQty: number;
      };
      expected: {
        avgCost: string;
        marginPerPcs: string;
        marginPerPack: string;
        expectedQty: number;
        diffQty: number;
        soldQty: number;
        turnover: string;
        cogs: string;
        marginTotal: string;
        closingValue: string;
      };
    }

    const data = loadFixture<G1Fixture>('g01.json');
    const res = calculateOpnameProduct(data.product);

    expect(res.costing?.avgCost.toString()).toBe(data.expected.avgCost);
    expect(res.marginPerPcsOwn?.toString()).toBe(data.expected.marginPerPcs);
    expect(res.costing?.avgCost ? res.sellPrice.minus(res.costing.avgCost).times(data.product.pcsPerPack).toString() : '').toBe(data.expected.marginPerPack);
    expect(res.expectedQty).toBe(data.expected.expectedQty);
    expect(res.diffQty).toBe(data.expected.diffQty);
    expect(res.soldQty).toBe(data.expected.soldQty);
    expect(res.turnover.toString()).toBe(data.expected.turnover);
    expect(res.costing?.cogs.toString()).toBe(data.expected.cogs);
    expect(res.marginTotalOwn?.toString()).toBe(data.expected.marginTotal);
    expect(res.costing?.closingValue.toString()).toBe(data.expected.closingValue);
  });

  it('G2: Titipan nominal (Pak Sani, contoh asli)', () => {
    interface G2Fixture {
      product: {
        productId: string;
        ownerType: 'consignor';
        consignorId: string;
        sellPrice: string;
        marginScheme: { type: 'nominal'; marginValue: string };
        openingQty: number;
        inQty: number;
        physicalQty: number;
      };
      expected: {
        soldQty: number;
        turnover: string;
        ownerMarginPerPcs: string;
        consignorSharePerPcs: string;
        ownerMarginTotal: string;
        soldShare: string;
        lossCompensation: string;
        payoutDue: string;
      };
    }

    const data = loadFixture<G2Fixture>('g02.json');
    const res = calculateOpnameProduct(data.product);

    expect(res.soldQty).toBe(data.expected.soldQty);
    expect(res.turnover.toString()).toBe(data.expected.turnover);
    expect(res.ownerMarginPerPcsConsignor?.toString()).toBe(data.expected.ownerMarginPerPcs);
    expect(res.consignorSharePerPcs?.toString()).toBe(data.expected.consignorSharePerPcs);
    expect(res.ownerMarginTotalConsignor?.toString()).toBe(data.expected.ownerMarginTotal);
    expect(res.soldShare?.toString()).toBe(data.expected.soldShare);
    expect(res.lossCompensation?.toString()).toBe(data.expected.lossCompensation);
    expect(res.payoutDue?.toString()).toBe(data.expected.payoutDue);
  });

  it('G3: Titipan persen (Kak Peja)', () => {
    interface G3Fixture {
      product: {
        productId: string;
        ownerType: 'consignor';
        consignorId: string;
        sellPrice: string;
        marginScheme: { type: 'percent'; marginPercentage: string };
        openingQty: number;
        inQty: number;
        physicalQty: number;
      };
      expected: {
        soldQty: number;
        turnover: string;
        ownerMarginPerPcs: string;
        consignorSharePerPcs: string;
        ownerMarginTotal: string;
        soldShare: string;
        lossCompensation: string;
        payoutDue: string;
      };
    }

    const data = loadFixture<G3Fixture>('g03.json');
    const res = calculateOpnameProduct(data.product);

    expect(res.soldQty).toBe(data.expected.soldQty);
    expect(res.turnover.toString()).toBe(data.expected.turnover);
    expect(res.ownerMarginPerPcsConsignor?.toString()).toBe(data.expected.ownerMarginPerPcs);
    expect(res.consignorSharePerPcs?.toString()).toBe(data.expected.consignorSharePerPcs);
    expect(res.ownerMarginTotalConsignor?.toString()).toBe(data.expected.ownerMarginTotal);
    expect(res.soldShare?.toString()).toBe(data.expected.soldShare);
    expect(res.lossCompensation?.toString()).toBe(data.expected.lossCompensation);
    expect(res.payoutDue?.toString()).toBe(data.expected.payoutDue);
  });

  it('G4: Loss titipan ditanggung owner', () => {
    interface G4Fixture {
      product: {
        productId: string;
        ownerType: 'consignor';
        consignorId: string;
        sellPrice: string;
        marginScheme: { type: 'nominal'; marginValue: string };
        openingQty: number;
        inQty: number;
        physicalQty: number;
        losses: LossItem[];
      };
      expected: {
        diffQty: number;
        lossQty: number;
        soldQty: number;
        turnover: string;
        ownerMarginPerPcs: string;
        consignorSharePerPcs: string;
        ownerMarginTotal: string;
        soldShare: string;
        lossCompensation: string;
        payoutDue: string;
        profitAContribution: string;
      };
    }

    const data = loadFixture<G4Fixture>('g04.json');
    const res = calculateOpnameProduct(data.product);

    expect(res.diffQty).toBe(data.expected.diffQty);
    expect(res.lossQty).toBe(data.expected.lossQty);
    expect(res.soldQty).toBe(data.expected.soldQty);
    expect(res.turnover.toString()).toBe(data.expected.turnover);
    expect(res.ownerMarginPerPcsConsignor?.toString()).toBe(data.expected.ownerMarginPerPcs);
    expect(res.consignorSharePerPcs?.toString()).toBe(data.expected.consignorSharePerPcs);
    expect(res.ownerMarginTotalConsignor?.toString()).toBe(data.expected.ownerMarginTotal);
    expect(res.soldShare?.toString()).toBe(data.expected.soldShare);
    expect(res.lossCompensation?.toString()).toBe(data.expected.lossCompensation);
    expect(res.payoutDue?.toString()).toBe(data.expected.payoutDue);

    // Profit A contribution = ownerMarginTotal - lossCompensation
    const profitAContrib = res.ownerMarginTotalConsignor!.minus(res.lossCompensation!);
    expect(profitAContrib.toString()).toBe(data.expected.profitAContribution);
  });

  it('G5: Loss titipan ditanggung penitip', () => {
    interface G5Fixture {
      product: {
        productId: string;
        ownerType: 'consignor';
        consignorId: string;
        sellPrice: string;
        marginScheme: { type: 'nominal'; marginValue: string };
        openingQty: number;
        inQty: number;
        physicalQty: number;
        losses: LossItem[];
      };
      expected: {
        diffQty: number;
        lossQty: number;
        soldQty: number;
        turnover: string;
        ownerMarginPerPcs: string;
        consignorSharePerPcs: string;
        ownerMarginTotal: string;
        soldShare: string;
        lossCompensation: string;
        payoutDue: string;
        profitAContribution: string;
      };
    }

    const data = loadFixture<G5Fixture>('g05.json');
    const res = calculateOpnameProduct(data.product);

    expect(res.diffQty).toBe(data.expected.diffQty);
    expect(res.lossQty).toBe(data.expected.lossQty);
    expect(res.soldQty).toBe(data.expected.soldQty);
    expect(res.turnover.toString()).toBe(data.expected.turnover);
    expect(res.payoutDue?.toString()).toBe(data.expected.payoutDue);
    expect(res.lossCompensation?.toString()).toBe('0');

    const profitAContrib = res.ownerMarginTotalConsignor!.minus(res.lossCompensation!);
    expect(profitAContrib.toString()).toBe(data.expected.profitAContribution);
  });

  it('G6: Own, weighted average + loss', () => {
    interface G6Fixture {
      product: {
        productId: string;
        ownerType: 'own';
        sellPrice: string;
        pcsPerPack: number;
        openingQty: number;
        openingValue: string;
        inQty: number;
        inCost: string;
        physicalQty: number;
        losses: LossItem[];
      };
      expected: {
        avgCost: string;
        expectedQty: number;
        diffQty: number;
        lossQty: number;
        soldQty: number;
        turnover: string;
        cogs: string;
        marginTotal: string;
        ownLossCost: string;
        closingValue: string;
        invariantI2TotalCost: string;
      };
    }

    const data = loadFixture<G6Fixture>('g06.json');
    const res = calculateOpnameProduct(data.product);

    expect(res.costing?.avgCost.toString()).toBe(data.expected.avgCost);
    expect(res.expectedQty).toBe(data.expected.expectedQty);
    expect(res.diffQty).toBe(data.expected.diffQty);
    expect(res.lossQty).toBe(data.expected.lossQty);
    expect(res.soldQty).toBe(data.expected.soldQty);
    expect(res.turnover.toString()).toBe(data.expected.turnover);
    expect(res.costing?.cogs.toString()).toBe(data.expected.cogs);
    expect(res.marginTotalOwn?.toString()).toBe(data.expected.marginTotal);
    expect(res.costing?.ownLossCost.toString()).toBe(data.expected.ownLossCost);
    expect(res.costing?.closingValue.toString()).toBe(data.expected.closingValue);

    // Invariant I2: 23.000 = 13.800 + 2.300 + 6.900
    const sumAllocated = res.costing!.cogs.plus(res.costing!.ownLossCost).plus(res.costing!.closingValue);
    expect(sumAllocated.toString()).toBe(data.expected.invariantI2TotalCost);
  });

  it('G7: Gabungan G6 + G2, uang pas', () => {
    interface G7Fixture {
      reconciliation: {
        qrisAmount: string;
        cashAmount: string;
        modalBelanjaOwn: string;
      };
      products: Array<{
        productId: string;
        ownerType: 'own' | 'consignor';
        consignorId?: string;
        sellPrice: string;
        openingQty: number;
        openingValue?: string;
        inQty: number;
        inCost?: string;
        physicalQty: number;
        losses: LossItem[];
        marginScheme?: { type: 'nominal'; marginValue: string };
      }>;
      expected: {
        theoreticalTurnover: string;
        realCash: string;
        cashDifference: string;
        payoutTotal: string;
        profitA: string;
        profitB: string;
        profitDiff: string;
        stockValueChange: string;
      };
    }

    const data = loadFixture<G7Fixture>('g07.json');
    const opnameProducts = data.products.map((p) => calculateOpnameProduct(p));

    const rec = calculateReconciliation({
      products: opnameProducts,
      qrisAmount: data.reconciliation.qrisAmount,
      cashAmount: data.reconciliation.cashAmount,
      modalBelanjaOwn: data.reconciliation.modalBelanjaOwn,
    });

    expect(rec.theoreticalTurnover.toString()).toBe(data.expected.theoreticalTurnover);
    expect(rec.realCash.toString()).toBe(data.expected.realCash);
    expect(rec.cashDifference.toString()).toBe(data.expected.cashDifference);
    expect(rec.totalPayoutDue.toString()).toBe(data.expected.payoutTotal);
    expect(rec.profitA.toString()).toBe(data.expected.profitA);
    expect(rec.profitB.toString()).toBe(data.expected.profitB);
    expect(rec.profitDiff.toString()).toBe(data.expected.profitDiff);
    expect(rec.invariantI3Satisfied).toBe(true);
  });

  it('G8: G7 dengan uang kurang', () => {
    interface G8Fixture {
      reconciliation: {
        qrisAmount: string;
        cashAmount: string;
        modalBelanjaOwn: string;
      };
      products: Array<{
        productId: string;
        ownerType: 'own' | 'consignor';
        consignorId?: string;
        sellPrice: string;
        openingQty: number;
        openingValue?: string;
        inQty: number;
        inCost?: string;
        physicalQty: number;
        losses: LossItem[];
        marginScheme?: { type: 'nominal'; marginValue: string };
      }>;
      expected: {
        theoreticalTurnover: string;
        realCash: string;
        cashDifference: string;
        payoutTotal: string;
        profitA: string;
        profitB: string;
        profitDiff: string;
        stockValueChange: string;
      };
    }

    const data = loadFixture<G8Fixture>('g08.json');
    const opnameProducts = data.products.map((p) => calculateOpnameProduct(p));

    const rec = calculateReconciliation({
      products: opnameProducts,
      qrisAmount: data.reconciliation.qrisAmount,
      cashAmount: data.reconciliation.cashAmount,
      modalBelanjaOwn: data.reconciliation.modalBelanjaOwn,
    });

    expect(rec.theoreticalTurnover.toString()).toBe(data.expected.theoreticalTurnover);
    expect(rec.realCash.toString()).toBe(data.expected.realCash);
    expect(rec.cashDifference.toString()).toBe(data.expected.cashDifference);
    expect(rec.profitA.toString()).toBe(data.expected.profitA);
    expect(rec.profitB.toString()).toBe(data.expected.profitB);
    expect(rec.profitDiff.toString()).toBe(data.expected.profitDiff);
    expect(rec.invariantI3Satisfied).toBe(true);
  });

  it('G9: Ledger penitip', () => {
    interface G9Fixture {
      consignorId: string;
      steps: Array<{
        step: number;
        accruals: string[];
        payments: string[];
        expectedBalance: string;
        expectedStatus: 'unpaid' | 'settled' | 'overpaid';
      }>;
    }

    const data = loadFixture<G9Fixture>('g09.json');
    for (const step of data.steps) {
      const summary = calculateConsignorLedger(
        data.consignorId,
        step.accruals,
        step.payments,
      );
      expect(summary.balance.toString()).toBe(step.expectedBalance);
      expect(summary.status).toBe(step.expectedStatus);
    }
  });

  it('G10: Persen + loss ditanggung owner', () => {
    interface G10Fixture {
      product: {
        productId: string;
        ownerType: 'consignor';
        consignorId: string;
        sellPrice: string;
        marginScheme: { type: 'percent'; marginPercentage: string };
        openingQty: number;
        inQty: number;
        physicalQty: number;
        losses: LossItem[];
      };
      expected: {
        diffQty: number;
        lossQty: number;
        soldQty: number;
        turnover: string;
        ownerMarginPerPcs: string;
        ownerMarginTotal: string;
        consignorSharePerPcs: string;
        soldShare: string;
        lossCompensation: string;
        payoutDue: string;
        profitAContribution: string;
      };
    }

    const data = loadFixture<G10Fixture>('g10.json');
    const res = calculateOpnameProduct(data.product);

    expect(res.diffQty).toBe(data.expected.diffQty);
    expect(res.lossQty).toBe(data.expected.lossQty);
    expect(res.soldQty).toBe(data.expected.soldQty);
    expect(res.turnover.toString()).toBe(data.expected.turnover);
    expect(res.ownerMarginPerPcsConsignor?.toString()).toBe(data.expected.ownerMarginPerPcs);
    expect(res.ownerMarginTotalConsignor?.toString()).toBe(data.expected.ownerMarginTotal);
    expect(res.consignorSharePerPcs?.toString()).toBe(data.expected.consignorSharePerPcs);
    expect(res.soldShare?.toString()).toBe(data.expected.soldShare);
    expect(res.lossCompensation?.toString()).toBe(data.expected.lossCompensation);
    expect(res.payoutDue?.toString()).toBe(data.expected.payoutDue);

    // Profit A contribution = ownerMarginTotal - lossCompensation
    // = 5.110 - 9.635 = -4.525 (check: T - payout = 140.000 - 144.525 = -4.525)
    const profitAContrib = res.ownerMarginTotalConsignor!.minus(res.lossCompensation!);
    expect(profitAContrib.toString()).toBe(data.expected.profitAContribution);
    expect(res.turnover.minus(res.payoutDue!).toString()).toBe(data.expected.profitAContribution);
  });

  it('G11: Tanpa pembulatan', () => {
    interface G11Fixture {
      product: {
        productId: string;
        ownerType: 'consignor';
        consignorId: string;
        sellPrice: string;
        marginScheme: { type: 'percent'; marginPercentage: string };
        openingQty: number;
        inQty: number;
        physicalQty: number;
        losses: LossItem[];
      };
      expected: {
        soldQty: number;
        turnover: string;
        ownerMarginPerPcs: string;
        ownerMarginTotal: string;
        consignorSharePerPcs: string;
        soldShare: string;
        payoutDue: string;
      };
    }

    const data = loadFixture<G11Fixture>('g11.json');
    const res = calculateOpnameProduct(data.product);

    expect(res.soldQty).toBe(data.expected.soldQty);
    expect(res.turnover.toString()).toBe(data.expected.turnover);
    expect(res.ownerMarginPerPcsConsignor?.toString()).toBe(data.expected.ownerMarginPerPcs);
    expect(res.ownerMarginTotalConsignor?.toString()).toBe(data.expected.ownerMarginTotal);
    expect(res.consignorSharePerPcs?.toString()).toBe(data.expected.consignorSharePerPcs);
    expect(res.soldShare?.toString()).toBe(data.expected.soldShare);
    expect(res.payoutDue?.toString()).toBe(data.expected.payoutDue);
  });
});
