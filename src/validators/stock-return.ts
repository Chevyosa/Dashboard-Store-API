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

export const createStockReturnSchema = z.object({
  productId: z.number().int('ID produk harus integer').positive('ID produk tidak valid'),
  qtyPcs: z.number().int('Jumlah pcs harus integer').positive('Jumlah pcs retur minimal 1'),
  date: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal tidak valid (gunakan format YYYY-MM-DD)',
  }),
  note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
});

export const updateStockReturnSchema = z.object({
  qtyPcs: z.number().int('Jumlah pcs harus integer').positive('Jumlah pcs retur minimal 1').optional(),
  date: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal tidak valid (gunakan format YYYY-MM-DD)',
  }).optional(),
  note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
});

export const listStockReturnsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  productId: z.coerce.number().int().positive().optional(),
  consignorId: z.coerce.number().int().positive().optional(),
  period: z.enum(['open', 'closed', 'all']).default('all'),
  startDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'startDate tidak valid (format YYYY-MM-DD)',
  }).optional(),
  endDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'endDate tidak valid (format YYYY-MM-DD)',
  }).optional(),
});

export type CreateStockReturnInput = z.infer<typeof createStockReturnSchema>;
export type UpdateStockReturnInput = z.infer<typeof updateStockReturnSchema>;
export type ListStockReturnsQuery = z.infer<typeof listStockReturnsQuerySchema>;
