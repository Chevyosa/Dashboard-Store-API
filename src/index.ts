import 'dotenv/config';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDbPool } from './config/db.js';

const env = loadEnv();
const pool = createDbPool(env);
const app = createApp({ pool, env });

const server = app.listen(env.PORT, () => {
  console.log(`API listening on port ${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool
      .end()
      .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : 'Failed to close DB pool');
      })
      .finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
