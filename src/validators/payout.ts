import { z } from 'zod';
import { parseOrThrow } from './auth.js';

export { parseOrThrow };

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

export const PAYMENT_METHODS = ['cash', 'transfer', 'qris'] as const;

export const createConsignorPaymentSchema = z.object({
  consignorId: z.coerce.number().int('ID penitip harus integer').positive('ID penitip tidak valid'),
  opnameId: z.coerce.number().int('ID opname harus integer').positive('ID opname tidak valid').nullable().optional(),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, 'Format nominal pembayaran tidak valid')
    .refine((v) => Number(v) > 0, 'Nominal pembayaran harus lebih besar dari 0'),
  paymentDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal pembayaran tidak valid (gunakan format YYYY-MM-DD)',
  }),
  paymentMethod: z.enum(PAYMENT_METHODS, {
    message: 'Metode pembayaran tidak valid',
  }).default('cash'),
  note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
});

export const listConsignorPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  consignorId: z.coerce.number().int().positive().optional(),
  opnameId: z.coerce.number().int().positive().optional(),
  startDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format startDate harus YYYY-MM-DD',
  }).optional(),
  endDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format endDate harus YYYY-MM-DD',
  }).optional(),
});

export const listConsignorLedgerQuerySchema = z.object({
  status: z.enum(['all', 'unpaid', 'settled', 'overpaid']).default('all'),
  search: z.string().trim().optional(),
});

export type CreateConsignorPaymentInput = z.infer<typeof createConsignorPaymentSchema>;
export type ListConsignorPaymentsQuery = z.infer<typeof listConsignorPaymentsQuerySchema>;
export type ListConsignorLedgerQuery = z.infer<typeof listConsignorLedgerQuerySchema>;
