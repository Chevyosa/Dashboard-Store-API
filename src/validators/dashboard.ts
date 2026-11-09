import { z } from 'zod';
import { parseOrThrow } from './auth.js';

export { parseOrThrow };

const MONEY_REGEX = /^\d+(\.\d{1,4})?$/;

export const reconciliationInputSchema = z.object({
  opnameId: z.coerce.number().int('ID opname harus integer').positive('ID opname tidak valid').optional(),
  cashAmount: z
    .string()
    .trim()
    .regex(MONEY_REGEX, 'Format nominal cash tidak valid')
    .default('0'),
  qrisAmount: z
    .string()
    .trim()
    .regex(MONEY_REGEX, 'Format nominal QRIS tidak valid')
    .default('0'),
  modalBelanjaOwn: z
    .string()
    .trim()
    .regex(MONEY_REGEX, 'Format modal belanja tidak valid')
    .optional(),
});

export type ReconciliationInputParams = z.infer<typeof reconciliationInputSchema>;
