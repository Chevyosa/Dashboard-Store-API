import { describe, expect, it } from 'vitest';
import * as domain from '../../../src/domain/index.js';

describe('domain/index (barrel exports)', () => {
  it('exports all domain functions, errors, and constants', () => {
    expect(domain.ZERO_MONEY).toBeDefined();
    expect(domain.parseMoney).toBeTypeOf('function');
    expect(domain.money).toBeTypeOf('function');
    expect(domain.addMoney).toBeTypeOf('function');
    expect(domain.subMoney).toBeTypeOf('function');
    expect(domain.mulMoney).toBeTypeOf('function');
    expect(domain.divMoney).toBeTypeOf('function');
    expect(domain.toDbString).toBeTypeOf('function');
    expect(domain.toDisplayString).toBeTypeOf('function');

    expect(domain.calculateOwnMargin).toBeTypeOf('function');
    expect(domain.calculateConsignorMargin).toBeTypeOf('function');

    expect(domain.calculatePeriodicAvgCost).toBeTypeOf('function');
    expect(domain.calculateOwnCosting).toBeTypeOf('function');

    expect(domain.calculateOpnameProduct).toBeTypeOf('function');
    expect(domain.getDefaultLossBorneBy).toBeTypeOf('function');

    expect(domain.calculateConsignorPayouts).toBeTypeOf('function');
    expect(domain.calculateConsignorLedger).toBeTypeOf('function');

    expect(domain.calculateReconciliation).toBeTypeOf('function');

    expect(domain.DomainError).toBeDefined();
    expect(domain.NegativeDiffStockError).toBeDefined();
    expect(domain.LossExceedsDiffStockError).toBeDefined();
    expect(domain.InvalidMarginError).toBeDefined();
    expect(domain.InvalidPercentageError).toBeDefined();
    expect(domain.InvalidLossBorneByError).toBeDefined();
    expect(domain.InvalidQuantityError).toBeDefined();
    expect(domain.InvalidMoneyError).toBeDefined();
  });
});
