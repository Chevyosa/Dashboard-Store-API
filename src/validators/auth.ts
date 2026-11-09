import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { PASSWORD_MAX_LENGTH } from '../utils/password.js';

export const loginSchema = z.object({
  username: z
    .string('Isi username.')
    .trim()
    .min(1, 'Isi username.')
    .max(64, 'Username terlalu panjang.'),
  password: z
    .string('Isi password.')
    .min(1, 'Isi password.')
    .max(PASSWORD_MAX_LENGTH, 'Password terlalu panjang.'),
});

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError(
    400,
    'VALIDATION_ERROR',
    'Data yang dikirim tidak valid.',
    result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}
