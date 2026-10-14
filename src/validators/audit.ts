import { z } from 'zod';
import { parseOrThrow } from './auth.js';

export { parseOrThrow };

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

export const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  action: z.string().trim().optional(),
  entityType: z.string().trim().optional(),
  entityId: z.string().trim().optional(),
  userId: z.coerce.number().int().positive().optional(),
  startDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format startDate harus YYYY-MM-DD',
  }).optional(),
  endDate: z.string().trim().refine(isValidCalendarDate, {
    message: 'Format endDate harus YYYY-MM-DD',
  }).optional(),
  search: z.string().trim().optional(),
});

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
