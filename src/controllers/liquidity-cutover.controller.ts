import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { createLiquidityCutoverService } from '../services/liquidity-cutover.js';
import { initializeCutoverSchema, parseOrThrow } from '../validators/liquidity-cutover.js';

export type LiquidityCutoverServiceInstance = ReturnType<typeof createLiquidityCutoverService>;

export function createLiquidityCutoverController(service: LiquidityCutoverServiceInstance) {
  return {
    async initialize(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(initializeCutoverSchema, req.body);
      const user = getAuthUser(res);
      const cutover = await service.initializeCutover(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(201).json({ data: cutover });
    },
  };
}
