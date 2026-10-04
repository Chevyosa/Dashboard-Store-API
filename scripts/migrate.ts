import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import { MigrationError, runMigrations } from '../src/db/migrator.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

try {
  const env = loadEnv();
  const result = await runMigrations(
    {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
    },
    dir,
    console.log,
  );
  console.log(`done: ${result.applied.length} applied, ${result.skipped.length} skipped`);
} catch (err) {
  console.error(err instanceof Error ? err.message : 'Migrasi gagal.');
  process.exitCode = err instanceof MigrationError ? 2 : 1;
}
