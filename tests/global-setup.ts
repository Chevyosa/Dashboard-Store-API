import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/db/migrator.js';
import { assertTestDatabase, getTestEnv } from './helpers/db.js';

// Runs once before the integration project: migrate the test database.
export default async function setup(): Promise<void> {
  const env = getTestEnv();
  assertTestDatabase(env.DB_NAME);
  await runMigrations(
    {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
    },
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations'),
  );
}
