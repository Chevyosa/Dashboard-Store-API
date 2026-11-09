import { Decimal } from 'decimal.js';
import { InvalidMoneyError } from './errors.js';

// Global Decimal configuration for high-precision business arithmetic (BR-01, BR-02)
Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30,
});

export type Money = Decimal;
export type MoneyInput = string | Decimal;

export const ZERO_MONEY = new Decimal(0);

/**
 * Parses and validates an input as a Decimal Money value.
 * Strictly rejects JavaScript `number` type to prevent float rounding errors (BR-01).
 */
export function parseMoney(value: MoneyInput): Decimal {
  if (value instanceof Decimal) {
    if (value.isNaN() || !value.isFinite()) {
      throw new InvalidMoneyError('Nilai desimal tidak valid');
    }
    return value;
  }

  if (typeof value !== 'string') {
    throw new InvalidMoneyError('Nilai uang harus berupa string desimal atau Decimal (BR-01)');
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    throw new InvalidMoneyError('Nilai uang tidak boleh kosong');
  }

  // Strictly match standard decimal notation, reject scientific notation and invalid chars
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidMoneyError(`Format uang tidak valid: "${value}"`);
  }

  return new Decimal(trimmed);
}

/**
 * Shorthand alias for parseMoney
 */
export function money(value: MoneyInput): Decimal {
  return parseMoney(value);
}

export function addMoney(a: MoneyInput, b: MoneyInput): Decimal {
  return parseMoney(a).plus(parseMoney(b));
}

export function subMoney(a: MoneyInput, b: MoneyInput): Decimal {
  return parseMoney(a).minus(parseMoney(b));
}

export function mulMoney(a: MoneyInput, b: MoneyInput): Decimal {
  return parseMoney(a).times(parseMoney(b));
}

export function divMoney(a: MoneyInput, b: MoneyInput): Decimal {
  const divisor = parseMoney(b);
  if (divisor.isZero()) {
    throw new InvalidMoneyError('Pembagian dengan nol tidak diizinkan');
  }
  return parseMoney(a).dividedBy(divisor);
}

export function isZeroMoney(a: MoneyInput): boolean {
  return parseMoney(a).isZero();
}

export function isPositiveMoney(a: MoneyInput): boolean {
  return parseMoney(a).isPositive() && !parseMoney(a).isZero();
}

export function isNegativeMoney(a: MoneyInput): boolean {
  return parseMoney(a).isNegative() && !parseMoney(a).isZero();
}

export function compareMoney(a: MoneyInput, b: MoneyInput): number {
  return parseMoney(a).comparedTo(parseMoney(b));
}

/**
 * Formats Decimal for database storage as DECIMAL(20,4).
 * Always produces fixed 4 decimal places string (e.g. "1000.0000", "283.8605").
 */
export function toDbString(value: MoneyInput): string {
  return parseMoney(value).toFixed(4);
}

/**
 * Returns exact Decimal string representation without fixed-width padding.
 */
export function toExactString(value: MoneyInput): string {
  return parseMoney(value).toString();
}

/**
 * Formats money according to BR-02:
 * Locale id-ID, maximumFractionDigits: 4, trailing decimal zeros removed.
 * Never uses float Number conversion.
 * Examples:
 *   1000      -> "1.000"
 *   283.8605  -> "283,8605"
 *   10.5      -> "10,5"
 *   -3000     -> "-3.000"
 *   0         -> "0"
 */
export function toDisplayString(value: MoneyInput): string {
  const m = parseMoney(value);
  const sign = m.isNegative() && !m.isZero() ? '-' : '';
  const abs = m.abs();

  // Split into integer part and decimal part from toFixed(4)
  const fixedStr = abs.toFixed(4);
  const [intPart, decPart] = fixedStr.split('.') as [string, string];

  // Format integer part with dot as thousand separator
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  // Strip trailing zeros from decimal part
  const trimmedDec = decPart.replace(/0+$/, '');

  if (trimmedDec.length > 0) {
    return `${sign}${formattedInt},${trimmedDec}`;
  }
  return `${sign}${formattedInt}`;
}
