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

const MONEY_REGEX = /^\d+(\.\d{1,4})?$/;

const moneyField = z
  .preprocess((val) => {
    if (val === undefined || val === null || val === '') return '0';
    return String(val).trim();
  }, z.string().regex(MONEY_REGEX, 'Format nominal uang tidak valid'))
  .default('0');

export const physicalItemInputSchema = z.object({
  productId: z
    .number()
    .int('ID produk harus integer')
    .positive('ID produk tidak valid'),
  physicalQty: z
    .number()
    .int('Stok fisik harus berupa integer')
    .min(0, 'Stok fisik tidak boleh negatif'),
});

export const prepareOpnameQuerySchema = z.object({
  date: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal opname tidak valid (format YYYY-MM-DD)',
  }),
});

export const calculateOpnameSchema = z.object({
  opnameDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal opname tidak valid (format YYYY-MM-DD)',
  }),
  items: z.array(physicalItemInputSchema),
  cashAmount: moneyField,
  qrisAmount: moneyField,
});

export const saveDraftOpnameSchema = z.object({
  opnameDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal opname tidak valid (format YYYY-MM-DD)',
  }),
  note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
  items: z.array(physicalItemInputSchema),
  cashAmount: moneyField,
  qrisAmount: moneyField,
});

export const finalizeOpnameSchema = z.object({
  opnameDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal opname tidak valid (format YYYY-MM-DD)',
  }),
  note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
  items: z
    .array(physicalItemInputSchema)
    .min(1, 'Minimal satu produk dalam pencatatan opname'),
  cashAmount: moneyField,
  qrisAmount: moneyField,
});

export const listOpnamesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['draft', 'final', 'all']).default('all'),
  startDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format startDate harus YYYY-MM-DD',
  }).optional(),
  endDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format endDate harus YYYY-MM-DD',
  }).optional(),
  sortBy: z.enum(['opname_date', 'id', 'created_at']).default('opname_date'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type PhysicalItemInput = z.infer<typeof physicalItemInputSchema>;
export type PrepareOpnameQuery = z.infer<typeof prepareOpnameQuerySchema>;
export type CalculateOpnameInput = z.infer<typeof calculateOpnameSchema>;
export type SaveDraftOpnameInput = z.infer<typeof saveDraftOpnameSchema>;
export type FinalizeOpnameInput = z.infer<typeof finalizeOpnameSchema>;
export type ListOpnamesQuery = z.infer<typeof listOpnamesQuerySchema>;
