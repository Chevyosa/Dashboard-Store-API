import { createHash, randomBytes } from 'node:crypto';

// 256-bit random token, URL-safe, delivered only through the session cookie.
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

// Only this hash is stored in the database (AGENTS.md §8).
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
