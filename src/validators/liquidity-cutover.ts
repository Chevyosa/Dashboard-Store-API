import { z } from 'zod';
import { parseOrThrow } from './auth.js';

export { parseOrThrow };

// DECIMAL(20,4): at most 16 integer digits and 4 fraction digits.
const AMOUNT_REGEX = /^\d{1,16}(\.\d{1,4})?$/;

// Strict: the cutover timestamp, actor and high-water marks are always
// server-derived, so a client cannot smuggle them in.
export const initializeCutoverSchema = z.strictObject({
  openingAmount: z
    .string('Saldo kas awal wajib berupa teks desimal')
    .trim()
    .regex(AMOUNT_REGEX, 'Format saldo kas awal tidak valid')
    .refine((v) => /[1-9]/.test(v), 'Saldo kas awal harus lebih besar dari 0'),
  openingUnpaidStock: z
    .string('Utang belanja awal wajib berupa teks desimal')
    .trim()
    .regex(AMOUNT_REGEX, 'Format utang belanja awal tidak valid'),
  confirmOpeningBalance: z.literal(true, {
    message: 'Konfirmasi bahwa saldo kas awal sudah dihitung fisik.',
  }),
  confirmLegacyPurchasesReconciled: z.literal(true, {
    message: 'Konfirmasi bahwa utang belanja lama sudah direkonsiliasi.',
  }),
});

export type InitializeCutoverInput = z.infer<typeof initializeCutoverSchema>;
