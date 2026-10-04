import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { InvalidMoneyError } from '../../../src/domain/errors.js';
import {
  addMoney,
  compareMoney,
  divMoney,
  isNegativeMoney,
  isPositiveMoney,
  isZeroMoney,
  money,
  mulMoney,
  parseMoney,
  subMoney,
  toDbString,
  toDisplayString,
  toExactString,
  ZERO_MONEY,
} from '../../../src/domain/money.js';

describe('domain/money', () => {
  describe('parseMoney', () => {
    it('parses valid integer strings', () => {
      const result = parseMoney('1000');
      expect(result.toString()).toBe('1000');
    });

    it('parses valid decimal strings', () => {
      const result = parseMoney('283.8605');
      expect(result.toString()).toBe('283.8605');
    });

    it('parses negative strings', () => {
      const result = parseMoney('-500.50');
      expect(result.toString()).toBe('-500.5');
    });

    it('returns the same Decimal instance if already Decimal', () => {
      const d = new Decimal('123.45');
      expect(parseMoney(d)).toBe(d);
    });

    it('throws on non-numeric or malformed strings', () => {
      expect(() => parseMoney('abc')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('12.34.56')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('   ')).toThrow(InvalidMoneyError);
      expect(() => parseMoney('1e5')).toThrow(InvalidMoneyError);
    });

    it('throws when passed JS number type to enforce BR-01', () => {
      // @ts-expect-error - testing runtime type rejection
      expect(() => parseMoney(1000)).toThrow(InvalidMoneyError);
    });

    it('throws when Decimal is NaN or Infinite', () => {
      expect(() => parseMoney(new Decimal(NaN))).toThrow(InvalidMoneyError);
      expect(() => parseMoney(new Decimal(Infinity))).toThrow(InvalidMoneyError);
    });
  });

  describe('money shorthand', () => {
    it('behaves identically to parseMoney', () => {
      expect(money('500').toString()).toBe('500');
    });
  });

  describe('arithmetic operations', () => {
    it('adds two amounts accurately', () => {
      const result = addMoney('0.1', '0.2');
      expect(result.toString()).toBe('0.3');
    });

    it('subtracts two amounts', () => {
      const result = subMoney('1000', '350.25');
      expect(result.toString()).toBe('649.75');
    });

    it('multiplies accurately without float precision loss', () => {
      const result = mulMoney('7777', '0.0365');
      expect(result.toString()).toBe('283.8605');
    });

    it('divides accurately', () => {
      const result = divMoney('23000', '10');
      expect(result.toString()).toBe('2300');
    });

    it('throws error when dividing by zero', () => {
      expect(() => divMoney('100', '0')).toThrow(InvalidMoneyError);
    });
  });

  describe('comparison & state checks', () => {
    it('checks zero', () => {
      expect(isZeroMoney('0')).toBe(true);
      expect(isZeroMoney('0.0000')).toBe(true);
      expect(isZeroMoney('1')).toBe(false);
      expect(isZeroMoney(ZERO_MONEY)).toBe(true);
    });

    it('checks positive and negative', () => {
      expect(isPositiveMoney('100')).toBe(true);
      expect(isPositiveMoney('0')).toBe(false);
      expect(isPositiveMoney('-50')).toBe(false);

      expect(isNegativeMoney('-50')).toBe(true);
      expect(isNegativeMoney('0')).toBe(false);
      expect(isNegativeMoney('50')).toBe(false);
    });

    it('compares amounts correctly', () => {
      expect(compareMoney('100', '50')).toBe(1);
      expect(compareMoney('50', '100')).toBe(-1);
      expect(compareMoney('100.00', '100')).toBe(0);
    });
  });

  describe('formatting functions', () => {
    it('formats toDbString as DECIMAL(20,4)', () => {
      expect(toDbString('1000')).toBe('1000.0000');
      expect(toDbString('283.8605')).toBe('283.8605');
      expect(toDbString('10.5')).toBe('10.5000');
      expect(toDbString('-50')).toBe('-50.0000');
    });

    it('formats toExactString', () => {
      expect(toExactString('1000')).toBe('1000');
      expect(toExactString('283.8605')).toBe('283.8605');
    });

    it('formats toDisplayString per BR-02 (id-ID locale, trailing zeros trimmed)', () => {
      expect(toDisplayString('1000')).toBe('1.000');
      expect(toDisplayString('283.8605')).toBe('283,8605');
      expect(toDisplayString('22479.4185')).toBe('22.479,4185');
      expect(toDisplayString('10.5000')).toBe('10,5');
      expect(toDisplayString('0')).toBe('0');
      expect(toDisplayString('-3000')).toBe('-3.000');
      expect(toDisplayString('-4.5250')).toBe('-4,525');
    });
  });
});
