import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { parseOrThrow } from './auth.js';
import { PAYMENT_METHODS } from './payout.js';

export { parseOrThrow };

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// DECIMAL(20,4): at most 16 integer digits and 4 fraction digits.
const AMOUNT_REGEX = /^\d{1,16}(\.\d{1,4})?$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidCalendarDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export const createStockInPaymentSchema = z.object({
  amount: z
    .string('Nominal pembayaran wajib berupa teks desimal')
    .trim()
    .regex(AMOUNT_REGEX, 'Format nominal pembayaran tidak valid')
    .refine((v) => /[1-9]/.test(v), 'Nominal pembayaran harus lebih besar dari 0'),
  paymentDate: z.string('Tanggal pembayaran wajib diisi').trim().refine(isValidCalendarDate, {
    message: 'Tanggal pembayaran tidak valid (gunakan format YYYY-MM-DD)',
  }),
  paymentMethod: z.enum(PAYMENT_METHODS, { message: 'Metode pembayaran tidak valid' }),
  note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
});

export type CreateStockInPaymentInput = z.infer<typeof createStockInPaymentSchema>;

/** Validates the Idempotency-Key header and normalizes it to lower case. */
export function parseIdempotencyKey(header: string | undefined): string {
  const key = header?.trim();
  if (!key || !UUID_REGEX.test(key)) {
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Header Idempotency-Key wajib diisi dengan UUID yang valid.',
    );
  }
  return key.toLowerCase();
}
