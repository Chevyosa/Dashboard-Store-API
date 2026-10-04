import { z } from 'zod';
import { parseMoney } from '../domain/money.js';
import { parseOrThrow } from './auth.js';

export { parseOrThrow };

// Regex desimal non-negatif
const DECIMAL_STRING_REGEX = /^\d+(\.\d+)?$/;

export const createProductSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Nama produk wajib diisi')
      .max(191, 'Nama produk maksimal 191 karakter'),
    ownerType: z.enum(['own', 'consignor']),
    consignorId: z
      .number()
      .int('ID penitip harus berupa bilangan bulat')
      .positive('ID penitip tidak valid')
      .nullable()
      .optional(),
    pcsPerPack: z
      .number()
      .int('Isi per kemasan harus berupa bilangan bulat')
      .min(1, 'Isi per kemasan minimal 1 pcs')
      .default(1),
    sellPrice: z
      .string()
      .trim()
      .regex(DECIMAL_STRING_REGEX, 'Format harga jual tidak valid'),
    marginType: z.enum(['nominal', 'percent']).nullable().optional(),
    marginValue: z
      .string()
      .trim()
      .regex(DECIMAL_STRING_REGEX, 'Format nilai margin tidak valid')
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    // 1. Validasi sellPrice > 0
    try {
      const sellPriceDec = parseMoney(data.sellPrice);
      if (sellPriceDec.lte(0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sellPrice'],
          message: 'Harga jual harus lebih besar dari 0',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sellPrice'],
        message: 'Format harga jual tidak valid',
      });
      return;
    }

    // 2. Aturan untuk Produk Milik Sendiri (own)
    if (data.ownerType === 'own') {
      if (data.consignorId !== null && data.consignorId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['consignorId'],
          message: 'Produk milik sendiri tidak boleh memiliki penitip (consignorId harus null)',
        });
      }
      if (data.marginType !== null && data.marginType !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['marginType'],
          message: 'Produk milik sendiri tidak menggunakan skema margin titipan (marginType harus null)',
        });
      }
      if (data.marginValue !== null && data.marginValue !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['marginValue'],
          message: 'Produk milik sendiri tidak menggunakan nilai margin titipan (marginValue harus null)',
        });
      }
      return;
    }

    // 3. Aturan untuk Produk Titipan (consignor)
    if (data.ownerType === 'consignor') {
      if (!data.consignorId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['consignorId'],
          message: 'Penitip wajib dipilih untuk produk titipan',
        });
      }

      if (!data.marginType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['marginType'],
          message: 'Skema margin (nominal atau percent) wajib dipilih untuk produk titipan',
        });
        return;
      }

      if (!data.marginValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['marginValue'],
          message: 'Nilai margin wajib diisi untuk produk titipan',
        });
        return;
      }

      try {
        const sellPriceDec = parseMoney(data.sellPrice);
        const marginDec = parseMoney(data.marginValue);

        if (data.marginType === 'nominal') {
          if (marginDec.lt(0)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['marginValue'],
              message: 'Margin nominal tidak boleh negatif',
            });
          }
          if (marginDec.gte(sellPriceDec)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['marginValue'],
              message: 'Margin nominal harus lebih kecil dari harga jual',
            });
          }
        } else if (data.marginType === 'percent') {
          if (marginDec.lte(0) || marginDec.gte(100)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['marginValue'],
              message: 'Persentase margin harus lebih besar dari 0% dan kurang dari 100%',
            });
          }
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['marginValue'],
          message: 'Format nilai margin tidak valid',
        });
      }
    }
  });

export const updateProductSchema = createProductSchema;

export const previewMarginSchema = z
  .object({
    ownerType: z.enum(['own', 'consignor']),
    pcsPerPack: z
      .number()
      .int()
      .min(1, 'Isi per kemasan minimal 1 pcs')
      .default(1),
    sellPrice: z
      .string()
      .trim()
      .regex(DECIMAL_STRING_REGEX, 'Format harga jual tidak valid'),
    marginType: z.enum(['nominal', 'percent']).optional(),
    marginValue: z
      .string()
      .trim()
      .regex(DECIMAL_STRING_REGEX, 'Format nilai margin tidak valid')
      .optional(),
    avgCost: z
      .string()
      .trim()
      .regex(DECIMAL_STRING_REGEX, 'Format modal rata-rata tidak valid')
      .optional(),
  })
  .superRefine((data, ctx) => {
    try {
      const sellPriceDec = parseMoney(data.sellPrice);
      if (sellPriceDec.lte(0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sellPrice'],
          message: 'Harga jual harus lebih besar dari 0',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sellPrice'],
        message: 'Format harga jual tidak valid',
      });
      return;
    }

    if (data.ownerType === 'consignor') {
      if (!data.marginType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['marginType'],
          message: 'Skema margin wajib dipilih untuk preview produk titipan',
        });
        return;
      }
      if (!data.marginValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['marginValue'],
          message: 'Nilai margin wajib diisi untuk preview produk titipan',
        });
        return;
      }
      try {
        const sellPriceDec = parseMoney(data.sellPrice);
        const marginDec = parseMoney(data.marginValue);
        if (data.marginType === 'nominal') {
          if (marginDec.lt(0) || marginDec.gte(sellPriceDec)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['marginValue'],
              message: 'Margin nominal harus >= 0 dan lebih kecil dari harga jual',
            });
          }
        } else if (data.marginType === 'percent') {
          if (marginDec.lte(0) || marginDec.gte(100)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['marginValue'],
              message: 'Persentase margin harus > 0% dan < 100%',
            });
          }
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['marginValue'],
          message: 'Format nilai margin tidak valid',
        });
      }
    }
  });

export const productQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  ownerType: z.enum(['own', 'consignor']).optional(),
  consignorId: z.coerce.number().int().positive().optional(),
  isActive: z.enum(['true', 'false', 'all']).default('all'),
  sortBy: z
    .enum(['name', 'ownerType', 'sellPrice', 'isActive', 'createdAt'])
    .default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const productStatusSchema = z.object({
  isActive: z.boolean(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type PreviewMarginInput = z.infer<typeof previewMarginSchema>;
export type ProductQueryInput = z.infer<typeof productQuerySchema>;
export type ProductStatusInput = z.infer<typeof productStatusSchema>;
