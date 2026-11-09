import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100),
  SESSION_SECRET: z.string().min(32, 'minimal 32 karakter'),
  CORS_ORIGIN: z.string().min(1),
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v)),
  // Number of reverse-proxy hops to trust for req.ip (0 = none; 1 behind Nginx).
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Konfigurasi environment tidak valid:\n- ${issues.join('\n- ')}`);
    this.name = 'EnvError';
  }
}

// Fail fast: throws with a readable list of problems (never prints values).
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvError(issues);
  }
  return result.data;
}

export function corsOrigins(env: Pick<Env, 'CORS_ORIGIN'>): string[] {
  return env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
