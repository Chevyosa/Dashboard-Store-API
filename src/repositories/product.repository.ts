import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface ProductEntity {
  id: number;
  name: string;
  ownerType: 'own' | 'consignor';
  consignorId: number | null;
  consignorName: string | null;
  pcsPerPack: number;
  sellPrice: string;
  marginType: 'nominal' | 'percent' | null;
  marginValue: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductData {
  name: string;
  ownerType: 'own' | 'consignor';
  consignorId: number | null;
  pcsPerPack: number;
  sellPrice: string;
  marginType: 'nominal' | 'percent' | null;
  marginValue: string | null;
}

export type UpdateProductData = CreateProductData;

export interface ProductQueryOptions {
  page: number;
  limit: number;
  search?: string | undefined;
  ownerType?: 'own' | 'consignor' | undefined;
  consignorId?: number | undefined;
  isActive?: 'true' | 'false' | 'all' | undefined;
  sortBy?: string | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
}

interface ProductRow extends RowDataPacket {
  id: number;
  name: string;
  owner_type: 'own' | 'consignor';
  consignor_id: number | null;
  consignor_name: string | null;
  pcs_per_pack: number;
  sell_price: string;
  margin_type: 'nominal' | 'percent' | null;
  margin_value: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

const SORT_COLUMN_WHITELIST: Record<string, string> = {
  name: 'p.name',
  ownerType: 'p.owner_type',
  sellPrice: 'p.sell_price',
  isActive: 'p.is_active',
  createdAt: 'p.created_at',
};

function mapRowToEntity(row: ProductRow): ProductEntity {
  return {
    id: Number(row.id),
    name: String(row.name),
    ownerType: row.owner_type,
    consignorId: row.consignor_id !== null ? Number(row.consignor_id) : null,
    consignorName: row.consignor_name ? String(row.consignor_name) : null,
    pcsPerPack: Number(row.pcs_per_pack),
    sellPrice: String(row.sell_price),
    marginType: row.margin_type,
    marginValue: row.margin_value !== null ? String(row.margin_value) : null,
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class ProductRepository {
  constructor(private pool: Pool) {}

  async create(data: CreateProductData, conn?: PoolConnection): Promise<ProductEntity> {
    const executor = conn ?? this.pool;
    const sql = `
      INSERT INTO products (
        name,
        owner_type,
        consignor_id,
        pcs_per_pack,
        sell_price,
        margin_type,
        margin_value,
        is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `;
    const params: (string | number | null)[] = [
      data.name,
      data.ownerType,
      data.consignorId,
      data.pcsPerPack,
      data.sellPrice,
      data.marginType,
      data.marginValue,
    ];

    const [result] = await executor.execute<ResultSetHeader>(sql, params);
    const created = await this.findById(result.insertId, conn);
    if (!created) {
      throw new Error('Gagal mengambil data produk setelah dibuat');
    }
    return created;
  }

  async findById(id: number, conn?: PoolConnection): Promise<ProductEntity | null> {
    const executor = conn ?? this.pool;
    const sql = `
      SELECT
        p.id,
        p.name,
        p.owner_type,
        p.consignor_id,
        c.name AS consignor_name,
        p.pcs_per_pack,
        p.sell_price,
        p.margin_type,
        p.margin_value,
        p.is_active,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN consignors c ON p.consignor_id = c.id
      WHERE p.id = ?
      LIMIT 1
    `;
    const [rows] = await executor.execute<ProductRow[]>(sql, [id]);
    const row = rows[0];
    return row ? mapRowToEntity(row) : null;
  }

  async findByName(name: string, conn?: PoolConnection): Promise<ProductEntity | null> {
    const executor = conn ?? this.pool;
    const sql = `
      SELECT
        p.id,
        p.name,
        p.owner_type,
        p.consignor_id,
        c.name AS consignor_name,
        p.pcs_per_pack,
        p.sell_price,
        p.margin_type,
        p.margin_value,
        p.is_active,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN consignors c ON p.consignor_id = c.id
      WHERE LOWER(p.name) = LOWER(?)
      LIMIT 1
    `;
    const [rows] = await executor.execute<ProductRow[]>(sql, [name.trim()]);
    const row = rows[0];
    return row ? mapRowToEntity(row) : null;
  }

  async findAll(
    options: ProductQueryOptions,
    conn?: PoolConnection,
  ): Promise<{ data: ProductEntity[]; total: number }> {
    const executor = conn ?? this.pool;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.search) {
      conditions.push('(p.name LIKE ? OR c.name LIKE ?)');
      const pattern = `%${options.search.trim()}%`;
      params.push(pattern, pattern);
    }

    if (options.ownerType) {
      conditions.push('p.owner_type = ?');
      params.push(options.ownerType);
    }

    if (options.consignorId) {
      conditions.push('p.consignor_id = ?');
      params.push(options.consignorId);
    }

    if (options.isActive === 'true') {
      conditions.push('p.is_active = 1');
    } else if (options.isActive === 'false') {
      conditions.push('p.is_active = 0');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total query
    const countSql = `
      SELECT COUNT(*) AS total
      FROM products p
      LEFT JOIN consignors c ON p.consignor_id = c.id
      ${whereClause}
    `;
    const [countRows] = await executor.execute<RowDataPacket[]>(countSql, params);
    const total = Number(countRows[0]?.total ?? 0);

    // Sorting
    const sortCol = SORT_COLUMN_WHITELIST[options.sortBy ?? 'name'] ?? 'p.name';
    const sortDir = options.sortOrder?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    // Pagination
    const page = Math.max(1, options.page);
    const limit = Math.max(1, Math.min(100, options.limit));
    const offset = (page - 1) * limit;

    const dataSql = `
      SELECT
        p.id,
        p.name,
        p.owner_type,
        p.consignor_id,
        c.name AS consignor_name,
        p.pcs_per_pack,
        p.sell_price,
        p.margin_type,
        p.margin_value,
        p.is_active,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN consignors c ON p.consignor_id = c.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await executor.execute<ProductRow[]>(dataSql, params);
    return {
      data: rows.map(mapRowToEntity),
      total,
    };
  }

  async update(id: number, data: UpdateProductData, conn?: PoolConnection): Promise<ProductEntity | null> {
    const executor = conn ?? this.pool;
    const sql = `
      UPDATE products
      SET
        name = ?,
        owner_type = ?,
        consignor_id = ?,
        pcs_per_pack = ?,
        sell_price = ?,
        margin_type = ?,
        margin_value = ?
      WHERE id = ?
    `;
    const params: (string | number | null)[] = [
      data.name,
      data.ownerType,
      data.consignorId,
      data.pcsPerPack,
      data.sellPrice,
      data.marginType,
      data.marginValue,
      id,
    ];

    const [res] = await executor.execute<ResultSetHeader>(sql, params);
    if (res.affectedRows === 0) {
      return null;
    }

    return this.findById(id, conn);
  }

  async setStatus(id: number, isActive: boolean, conn?: PoolConnection): Promise<ProductEntity | null> {
    const executor = conn ?? this.pool;
    const sql = 'UPDATE products SET is_active = ? WHERE id = ?';
    const [res] = await executor.execute<ResultSetHeader>(sql, [isActive ? 1 : 0, id]);
    if (res.affectedRows === 0) {
      return null;
    }

    return this.findById(id, conn);
  }

  async countByConsignorId(consignorId: number, conn?: PoolConnection): Promise<number> {
    const executor = conn ?? this.pool;
    const sql = 'SELECT COUNT(*) AS total FROM products WHERE consignor_id = ?';
    const [rows] = await executor.execute<RowDataPacket[]>(sql, [consignorId]);
    return Number(rows[0]?.total ?? 0);
  }
}
