import express from 'express';
import type { Express } from 'express';
import { healthRouter } from './routes/health.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';

// Builds the Express instance without listening, so tests can import it.
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
