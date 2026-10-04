import { z } from 'zod';
import { parseMoney } from '../domain/money.js';
import { parseOrThrow } from './auth.js';

function validateMargin(
  type: 'nominal' | 'percent' | null | undefined,
  value: string | null | undefined,
  ctx: z.RefinementCtx,
) {
  if (type && !value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultMarginValue'],
      message: 'Nilai margin default wajib diisi jika jenis margin dipilih.',
    });
    return;
  }
  if (!type && value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultMarginType'],
      message: 'Jenis margin default wajib dipilih jika nilai margin diisi.',
    });
    return;
  }
  if (type && value) {
    try {
      const parsed = parseMoney(value);
      if (type === 'nominal') {
        if (parsed.isNegative()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['defaultMarginValue'],
            message: 'Nilai margin nominal tidak boleh negatif.',
          });
        }
      } else if (type === 'percent') {
        if (parsed.lte(0) || parsed.gte(100)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['defaultMarginValue'],
            message: 'Persentase margin harus lebih besar dari 0% dan kurang dari 100%.',
          });
        }
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultMarginValue'],
        message: 'Format nilai margin tidak valid.',
      });
    }
  }
}

export const createConsignorSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Nama penitip wajib diisi.')
      .max(100, 'Nama penitip maksimal 100 karakter.'),
    phone: z.string().trim().max(30, 'Nomor telepon maksimal 30 karakter.').nullable().optional(),
    note: z.string().trim().nullable().optional(),
    defaultMarginType: z.enum(['nominal', 'percent']).nullable().optional(),
    defaultMarginValue: z.string().trim().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    validateMargin(data.defaultMarginType, data.defaultMarginValue, ctx);
  });

export const updateConsignorSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Nama penitip wajib diisi.')
      .max(100, 'Nama penitip maksimal 100 karakter.')
      .optional(),
    phone: z.string().trim().max(30, 'Nomor telepon maksimal 30 karakter.').nullable().optional(),
    note: z.string().trim().nullable().optional(),
    defaultMarginType: z.enum(['nominal', 'percent']).nullable().optional(),
    defaultMarginValue: z.string().trim().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    // If either is explicitly provided, validate the pair
    if (data.defaultMarginType !== undefined || data.defaultMarginValue !== undefined) {
      validateMargin(data.defaultMarginType, data.defaultMarginValue, ctx);
    }
  });

export const listConsignorsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  status: z.enum(['all', 'active', 'inactive']).default('active'),
  sortBy: z.enum(['name', 'createdAt']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const toggleConsignorStatusSchema = z.object({
  isActive: z.boolean(),
});

export { parseOrThrow };
