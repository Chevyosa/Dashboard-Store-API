import type { Request, Response } from 'express';
import { getAuthUser } from '../middlewares/require-auth.js';
import type { createProductService } from '../services/product.service.js';
import { AppError } from '../utils/errors.js';
import {
  createProductSchema,
  updateProductSchema,
  previewMarginSchema,
  productQuerySchema,
  productStatusSchema,
  parseOrThrow,
} from '../validators/product.js';

export type ProductServiceInstance = ReturnType<typeof createProductService>;

function parseId(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'INVALID_ID', 'ID produk tidak valid.');
  }
  return id;
}

export function createProductController(service: ProductServiceInstance) {
  return {
    async previewMargin(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(previewMarginSchema, req.body);
      const result = service.previewMargin(input);
      res.status(200).json({ data: result });
    },

    async create(req: Request, res: Response): Promise<void> {
      const input = parseOrThrow(createProductSchema, req.body);
      const user = getAuthUser(res);
      const product = await service.createProduct(user.id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(201).json({ data: product });
    },

    async list(req: Request, res: Response): Promise<void> {
      const query = parseOrThrow(productQuerySchema, req.query);
      const result = await service.listProducts(query);
      res.status(200).json({ data: result.data, pagination: result.pagination });
    },

    async getById(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const product = await service.getProductById(id);
      res.status(200).json({ data: product });
    },

    async update(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const input = parseOrThrow(updateProductSchema, req.body);
      const user = getAuthUser(res);
      const product = await service.updateProduct(user.id, id, input, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ data: product });
    },

    async setStatus(req: Request, res: Response): Promise<void> {
      const id = parseId(req.params.id);
      const input = parseOrThrow(productStatusSchema, req.body);
      const user = getAuthUser(res);
      const product = await service.setProductStatus(user.id, id, input.isActive, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json({ data: product });
    },
  };
}
