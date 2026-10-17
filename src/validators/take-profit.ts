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

export const TAKE_PROFIT_PAYMENT_METHODS = ['cash', 'transfer'] as const;

export const createTakeProfitSchema = z.object({
  opnameId: z.coerce.number().int('ID opname harus integer').positive('ID opname tidak valid').nullable().optional(),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, 'Format nominal penarikan tidak valid')
    .refine((v) => Number(v) > 0, 'Nominal penarikan harus lebih besar dari 0'),
  withdrawalDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal penarikan tidak valid (gunakan format YYYY-MM-DD)',
  }),
  paymentMethod: z.enum(TAKE_PROFIT_PAYMENT_METHODS, {
    message: 'Metode penarikan tidak valid',
  }).default('cash'),
  note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
});

export const updateWorkingCapitalSchema = z.object({
  minWorkingCapital: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, 'Format nominal modal tidak valid')
    .refine((v) => Number(v) >= 0, 'Nominal modal tidak boleh negatif'),
});

export const listTakeProfitsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  opnameId: z.coerce.number().int().positive().optional(),
  startDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format startDate harus YYYY-MM-DD',
  }).optional(),
  endDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format endDate harus YYYY-MM-DD',
  }).optional(),
});

export type CreateTakeProfitInput = z.infer<typeof createTakeProfitSchema>;
export type UpdateWorkingCapitalInput = z.infer<typeof updateWorkingCapitalSchema>;
export type ListTakeProfitsQuery = z.infer<typeof listTakeProfitsQuerySchema>;
