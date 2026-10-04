import { z } from 'zod';
import { parseMoney } from '../domain/money.js';
import { parseOrThrow } from './auth.js';

export { parseOrThrow };

const DECIMAL_STRING_REGEX = /^\d+(\.\d+)?$/;
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

export const stockInLineInputSchema = z
  .object({
    productId: z.number().int('ID produk harus integer').positive('ID produk tidak valid'),
    inputMode: z.enum(['pack', 'pcs']).default('pcs'),
    qtyPack: z.number().int('Qty pack harus integer').positive('Qty pack minimal 1').nullable().optional(),
    qtyPcs: z.number().int('Qty pcs harus integer').positive('Qty pcs minimal 1').nullable().optional(),
    totalCost: z
      .string()
      .trim()
      .regex(DECIMAL_STRING_REGEX, 'Format total biaya tidak valid')
      .default('0'),
  })
  .superRefine((val, ctx) => {
    if (val.inputMode === 'pack') {
      if (val.qtyPack === null || val.qtyPack === undefined || val.qtyPack < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['qtyPack'],
          message: 'Jumlah pack wajib diisi minimal 1 jika input mode pack',
        });
      }
    } else {
      if (val.qtyPcs === null || val.qtyPcs === undefined || val.qtyPcs < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['qtyPcs'],
          message: 'Jumlah pcs wajib diisi minimal 1 jika input mode pcs',
        });
      }
    }

    try {
      const dec = parseMoney(val.totalCost);
      if (dec.isNegative()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['totalCost'],
          message: 'Total biaya tidak boleh negatif',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalCost'],
        message: 'Format total biaya tidak valid',
      });
    }
  });

export const createStockInSchema = z
  .object({
    type: z.enum(['purchase', 'consignment_in', 'initial'], {
      message: 'Tipe barang masuk harus purchase, consignment_in, atau initial',
    }),
    date: z.string().trim().refine(isValidCalendarDate, {
      message: 'Tanggal tidak valid (gunakan format YYYY-MM-DD)',
    }),
    note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
    lines: z.array(stockInLineInputSchema).min(1, 'Minimal satu baris produk wajib dimasukkan'),
  });

export const updateStockInSchema = z
  .object({
    date: z.string().trim().refine(isValidCalendarDate, {
      message: 'Tanggal tidak valid (gunakan format YYYY-MM-DD)',
    }).optional(),
    note: z.string().trim().max(1000, 'Catatan maksimal 1000 karakter').nullable().optional(),
    lines: z.array(stockInLineInputSchema).min(1, 'Minimal satu baris produk wajib dimasukkan').optional(),
  });

export const listStockInsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(['purchase', 'consignment_in', 'initial']).optional(),
  period: z.enum(['open', 'closed', 'all']).default('all'),
  startDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'startDate tidak valid (format YYYY-MM-DD)',
  }).optional(),
  endDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'endDate tidak valid (format YYYY-MM-DD)',
  }).optional(),
});

export type StockInLineInput = z.infer<typeof stockInLineInputSchema>;
export type CreateStockInInput = z.infer<typeof createStockInSchema>;
export type UpdateStockInInput = z.infer<typeof updateStockInSchema>;
export type ListStockInsQuery = z.infer<typeof listStockInsQuerySchema>;
