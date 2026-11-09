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

export const LOSS_REASONS = [
  'expired',
  'damaged_on_display',
  'damaged_before_display',
  'lost',
  'other',
] as const;

export const LOSS_BORNE_BY = ['owner', 'consignor'] as const;

export const createLossSchema = z.object({
  productId: z.number().int('ID produk harus integer').positive('ID produk tidak valid'),
  qtyPcs: z.number().int('Jumlah pcs harus integer').positive('Jumlah pcs minimal 1'),
  reason: z.enum(LOSS_REASONS, {
    message: 'Alasan loss tidak valid',
  }),
  borneBy: z.enum(LOSS_BORNE_BY, {
    message: 'Penanggung loss tidak valid',
  }).optional(),
  date: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal tidak valid (gunakan format YYYY-MM-DD)',
  }),
  note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
});

export const updateLossSchema = z.object({
  productId: z.number().int('ID produk harus integer').positive('ID produk tidak valid').optional(),
  qtyPcs: z.number().int('Jumlah pcs harus integer').positive('Jumlah pcs minimal 1').optional(),
  reason: z.enum(LOSS_REASONS, {
    message: 'Alasan loss tidak valid',
  }).optional(),
  borneBy: z.enum(LOSS_BORNE_BY, {
    message: 'Penanggung loss tidak valid',
  }).optional(),
  date: z.string().trim().refine(isValidCalendarDate, {
    message: 'Tanggal tidak valid (gunakan format YYYY-MM-DD)',
  }).optional(),
  note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
});

export const listLossesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  period: z.enum(['open', 'closed', 'all']).default('all'),
  reason: z.enum(LOSS_REASONS).optional(),
  borneBy: z.enum(LOSS_BORNE_BY).optional(),
  productId: z.coerce.number().int().positive().optional(),
  startDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format startDate harus YYYY-MM-DD',
  }).optional(),
  endDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format endDate harus YYYY-MM-DD',
  }).optional(),
  sortBy: z.enum(['date', 'id', 'qty_pcs', 'created_at']).default('date'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateLossInput = z.infer<typeof createLossSchema>;
export type UpdateLossInput = z.infer<typeof updateLossSchema>;
export type ListLossesQuery = z.infer<typeof listLossesQuerySchema>;
