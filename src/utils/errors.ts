export interface ErrorDetail {
  path: string;
  message: string;
}

// Business/HTTP error with a stable code and a user-facing Indonesian message.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'AppError';
  }
}
