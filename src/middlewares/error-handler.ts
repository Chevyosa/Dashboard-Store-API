import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Sumber daya tidak ditemukan.', details: [] },
  });
};

function bodyParserType(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'type' in err) {
    const type = (err as { type: unknown }).type;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

// Generic 500: never leak stack traces or internals to the client.
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  const type = bodyParserType(err);
  if (type === 'entity.parse.failed') {
    res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Isi permintaan bukan JSON yang valid.',
        details: [],
      },
    });
    return;
  }
  if (type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Isi permintaan terlalu besar.', details: [] },
    });
    return;
  }
  console.error(err instanceof Error ? err.message : 'Unknown error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server.', details: [] },
  });
};
