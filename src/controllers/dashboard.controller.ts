import type { Request, Response } from 'express';
import type { createDashboardService } from '../services/dashboard.service.js';
import { parseOrThrow, reconciliationInputSchema } from '../validators/dashboard.js';

export type DashboardServiceInstance = ReturnType<typeof createDashboardService>;

export function createDashboardController(service: DashboardServiceInstance) {
  return {
    async getSummary(_req: Request, res: Response): Promise<void> {
      const summary = await service.getSummary();
      res.status(200).json({ data: summary });
    },

    async reconcile(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(reconciliationInputSchema, req.body);
      const result = await service.calculateReconciliation(input);
      res.status(200).json({ data: result });
    },
  };
}
