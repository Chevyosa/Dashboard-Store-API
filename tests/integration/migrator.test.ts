import { copyFile, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrationFiles, MigrationError, runMigrations } from '../../src/db/migrator.js';
import type { MigratorDbConfig } from '../../src/db/migrator.js';
import { assertTestDatabase, getTestEnv } from '../helpers/db.js';

// Throwaway database so these tests never disturb store_test.
// DROP is only ever issued for this exact, guard-checked name.
const SCRATCH = 'store_migrator_test';
const REAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

const env = getTestEnv();
const config: MigratorDbConfig = {
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: SCRATCH,
};

async function withAdmin<T>(fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const c = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  });
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function resetScratch(): Promise<void> {
  assertTestDatabase(SCRATCH);
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
    await c.query(
      `CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  });
}

async function query(sql: string): Promise<RowDataPacket[]> {
  assertTestDatabase(SCRATCH);
  const c = await mysql.createConnection(config);
  try {
    const [rows] = await c.query<RowDataPacket[]>(sql);
    return rows;
  } finally {
    await c.end();
  }
}

let dir = '';

beforeEach(async () => {
  await resetScratch();
  dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  assertTestDatabase(SCRATCH);
  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``));
});

const write = (name: string, sql: string): Promise<void> => writeFile(path.join(dir, name), sql);

describe('runMigrations', () => {
  it('applies the real migrations onto an empty database', async () => {
    const result = await runMigrations(config, REAL_DIR);
    expect(result.applied).toEqual([
      '0001_users.sql',
      '0002_sessions.sql',
      '0003_audit_log.sql',
      '0004_audit_log_auth_lookup.sql',
      '0005_consignors.sql',
      '0006_products.sql',
      '0007_stock_ins_and_returns.sql',
      '0008_loss_records.sql',
      '0009_opnames.sql',
      '0010_consignor_payments.sql',
      '0011_opname_cash_reconciliation.sql',
      '0012_take_profits.sql',
      '0013_store_liquidity_ledger.sql',
    ]);
    const tables = await query(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = '${SCRATCH}'`,
    );
    expect(tables.map((t) => t.name).sort()).toEqual([
      'audit_log',
      'consignor_payments',
      'consignors',
      'liquidity_cutover',
      'liquidity_events',
      'loss_records',
      'opname_consignor_payouts',
      'opname_items',
      'opnames',
      'products',
      'schema_migrations',
      'sessions',
      'stock_in_lines',
      'stock_in_payments',
      'stock_ins',
      'stock_returns',
      'store_settings',
      'take_profits',
      'users',
    ]);
  });

  it('applies files in order and records version, filename and sha256 checksum', async () => {
    await write('0002_b.sql', 'CREATE TABLE b (id INT PRIMARY KEY);');
    await write('0001_a.sql', 'CREATE TABLE a (id INT PRIMARY KEY);');
    const result = await runMigrations(config, dir);
    expect(result.applied).toEqual(['0001_a.sql', '0002_b.sql']);
    const rows = await query(
      'SELECT version, filename, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toEqual(['0001', '0002']);
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a no-op when run again', async () => {
    await write('0001_a.sql', 'CREATE TABLE a (id INT PRIMARY KEY);');
    await runMigrations(config, dir);
    const second = await runMigrations(config, dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_a.sql']);
    expect(await query('SELECT version FROM schema_migrations')).toHaveLength(1);
  });

  it('applies only new files on a later run', async () => {
    await write('0001_a.sql', 'CREATE TABLE a (id INT PRIMARY KEY);');
    await runMigrations(config, dir);
    await write('0002_b.sql', 'CREATE TABLE b (id INT PRIMARY KEY);');
    const result = await runMigrations(config, dir);
    expect(result.applied).toEqual(['0002_b.sql']);
    expect(result.skipped).toEqual(['0001_a.sql']);
  });

  it('fails hard when an applied migration was edited (checksum mismatch)', async () => {
    await write('0001_a.sql', 'CREATE TABLE a (id INT PRIMARY KEY);');
    await runMigrations(config, dir);
    await write('0001_a.sql', 'CREATE TABLE a (id INT PRIMARY KEY, extra INT);');
    const run = runMigrations(config, dir);
    await expect(run).rejects.toBeInstanceOf(MigrationError);
    await expect(run).rejects.toThrow(/Checksum berubah untuk 0001_a\.sql/);
  });

  it('fails hard when an applied migration file is missing', async () => {
    await write('0001_a.sql', 'CREATE TABLE a (id INT PRIMARY KEY);');
    await runMigrations(config, dir);
    await unlink(path.join(dir, '0001_a.sql'));
    await expect(runMigrations(config, dir)).rejects.toThrow(/File migrasi hilang: 0001_a\.sql/);
  });

  it('rejects a new migration numbered below an applied one', async () => {
    await write('0002_b.sql', 'CREATE TABLE b (id INT PRIMARY KEY);');
    await runMigrations(config, dir);
    await write('0001_a.sql', 'CREATE TABLE a (id INT PRIMARY KEY);');
    await expect(runMigrations(config, dir)).rejects.toThrow(/di luar urutan/);
  });

  it('rejects invalid file names and duplicate version numbers', async () => {
    await write('bad-name.sql', 'SELECT 1;');
    await expect(runMigrations(config, dir)).rejects.toThrow(/Nama file migrasi tidak valid/);
    await rm(path.join(dir, 'bad-name.sql'));

    await write('0001_a.sql', 'SELECT 1;');
    await write('0001_b.sql', 'SELECT 1;');
    await expect(runMigrations(config, dir)).rejects.toThrow(/Nomor migrasi ganda 0001/);
  });

  it('does not record a failed migration but keeps earlier ones', async () => {
    await write('0001_a.sql', 'CREATE TABLE a (id INT PRIMARY KEY);');
    await write('0002_broken.sql', 'CREATE TABLE broken (;');
    await expect(runMigrations(config, dir)).rejects.toThrow(/0002_broken\.sql gagal/);
    const rows = await query('SELECT filename FROM schema_migrations');
    expect(rows.map((r) => r.filename)).toEqual(['0001_a.sql']);
  });

  it('ignores non-sql files such as .gitkeep', async () => {
    await write('.gitkeep', '');
    await write('README.md', '# notes');
    await write('0001_a.sql', 'CREATE TABLE a (id INT PRIMARY KEY);');
    const result = await runMigrations(config, dir);
    expect(result.applied).toEqual(['0001_a.sql']);
  });
});

// ---------------------------------------------------------------------------
// Liquidity ledger schema (migration 0013). All statements below run only
// against the guard-checked scratch database.
// ---------------------------------------------------------------------------

const LIQUIDITY_MIGRATION = '0013_store_liquidity_ledger.sql';
const LIQUIDITY_TABLES = ['liquidity_cutover', 'liquidity_events', 'stock_in_payments'];

async function withScratch<T>(fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  assertTestDatabase(SCRATCH);
  const c = await mysql.createConnection({ ...config, timezone: 'Z', dateStrings: true });
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function run(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  return withScratch(async (c) => {
    const [res] = await c.query<ResultSetHeader>(sql, params);
    return res;
  });
}

async function rowsOf(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  return withScratch(async (c) => {
    const [rows] = await c.query<RowDataPacket[]>(sql, params);
    return rows;
  });
}

async function expectRejected(sql: string, params: unknown[], code: string): Promise<void> {
  await expect(run(sql, params)).rejects.toMatchObject({ code });
}

async function columnsOf(table: string): Promise<Map<string, RowDataPacket>> {
  const rows = await rowsOf(
    `SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
            column_default AS def
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?`,
    [SCRATCH, table],
  );
  return new Map(rows.map((r) => [String(r.name), r]));
}

function expectColumn(
  cols: Map<string, RowDataPacket>,
  name: string,
  type: string,
  nullable: 'YES' | 'NO',
): void {
  const col = cols.get(name);
  expect(col, `column ${name}`).toBeDefined();
  expect(String(col?.type).toLowerCase(), `type of ${name}`).toBe(type);
  expect(col?.nullable, `nullability of ${name}`).toBe(nullable);
}

function expectUtcDefault(cols: Map<string, RowDataPacket>, name: string): void {
  expect(String(cols.get(name)?.def).toLowerCase(), `default of ${name}`).toContain(
    'utc_timestamp(3)',
  );
}

async function seedUserAndStockIn(): Promise<{ userId: number; stockInId: number }> {
  const user = await run(`INSERT INTO users (username, password_hash) VALUES ('owner', 'x')`);
  const stockIn = await run(`INSERT INTO stock_ins (type, date) VALUES ('purchase', '2026-11-01')`);
  return { userId: user.insertId, stockInId: stockIn.insertId };
}

const insertEvent = (
  eventType: string,
  sourceType: string,
  sourceId: number,
  amount: string,
  createdBy: number | null = null,
): Promise<ResultSetHeader> =>
  run(
    `INSERT INTO liquidity_events
       (event_type, source_type, source_id, amount_delta, effective_date, created_by)
     VALUES (?, ?, ?, ?, '2026-11-01', ?)`,
    [eventType, sourceType, sourceId, amount, createdBy],
  );

const insertStockInPayment = (
  stockInId: number,
  amount: string,
  key: string | null,
  createdBy: number | null = null,
): Promise<ResultSetHeader> =>
  run(
    `INSERT INTO stock_in_payments
       (stock_in_id, amount, payment_date, payment_method, idempotency_key, created_by)
     VALUES (?, ?, '2026-11-02', 'transfer', ?, ?)`,
    [stockInId, amount, key, createdBy],
  );

const UUID_A = '3f2b8c1e-4d5a-4e6f-9a7b-0c1d2e3f4a5b';
const UUID_B = '9c8b7a6f-5e4d-4c3b-8a29-1f0e0d0c0b0a';

describe('liquidity schema (0013)', () => {
  beforeEach(async () => {
    await runMigrations(config, REAL_DIR);
  });

  it('is named so the migrator accepts it as version 0013, the latest migration', async () => {
    const files = await loadMigrationFiles(REAL_DIR);
    const last = files[files.length - 1];
    expect(last?.filename).toBe(LIQUIDITY_MIGRATION);
    expect(last?.version).toBe('0013');
  });

  it('runs on a MySQL server that enforces CHECK constraints (>= 8.0.16)', async () => {
    const [row] = await rowsOf('SELECT VERSION() AS v');
    const [major = 0, minor = 0, patch = 0] = String(row?.v)
      .split(/[.-]/)
      .slice(0, 3)
      .map(Number);
    expect(major * 10000 + minor * 100 + patch).toBeGreaterThanOrEqual(80016);
  });

  it('creates every liquidity table as InnoDB with utf8mb4_unicode_ci', async () => {
    const rows = await rowsOf(
      `SELECT table_name AS name, engine AS engine, table_collation AS coll
         FROM information_schema.tables
        WHERE table_schema = ? AND table_name IN (?)
        ORDER BY table_name`,
      [SCRATCH, LIQUIDITY_TABLES],
    );
    expect(rows.map((r) => [r.name, r.engine, r.coll])).toEqual(
      LIQUIDITY_TABLES.map((t) => [t, 'InnoDB', 'utf8mb4_unicode_ci']),
    );
  });

  it('seeds no cutover row, ledger event or payment', async () => {
    for (const table of LIQUIDITY_TABLES) {
      const [row] = await rowsOf(`SELECT COUNT(*) AS n FROM \`${table}\``);
      expect(Number(row?.n), table).toBe(0);
    }
  });

  describe('liquidity_cutover', () => {
    it('has opening amount, UTC cutover time and high-water ids per source', async () => {
      const cols = await columnsOf('liquidity_cutover');
      expectColumn(cols, 'id', 'tinyint unsigned', 'NO');
      expectColumn(cols, 'opening_amount', 'decimal(20,4)', 'NO');
      expectColumn(cols, 'cutover_at', 'datetime(3)', 'NO');
      expectColumn(cols, 'opname_high_water_id', 'bigint unsigned', 'NO');
      expectColumn(cols, 'stock_in_high_water_id', 'bigint unsigned', 'NO');
      expectColumn(cols, 'consignor_payment_high_water_id', 'bigint unsigned', 'NO');
      expectColumn(cols, 'take_profit_high_water_id', 'bigint unsigned', 'NO');
      expectColumn(cols, 'created_by', 'bigint unsigned', 'YES');
      expectColumn(cols, 'created_at', 'datetime(3)', 'NO');
      expectUtcDefault(cols, 'created_at');
    });

    it('keeps opening unpaid stock separate from opening cash, with a payment watermark', async () => {
      const cols = await columnsOf('liquidity_cutover');
      expectColumn(cols, 'opening_unpaid_stock', 'decimal(20,4)', 'NO');
      expectColumn(cols, 'stock_in_payment_high_water_id', 'bigint unsigned', 'NO');
      expect(String(cols.get('opening_unpaid_stock')?.def)).toBe('0.0000');
      expect(String(cols.get('stock_in_payment_high_water_id')?.def)).toBe('0');

      // Omitting both columns stores their defaults, independent of opening_amount.
      await run(`INSERT INTO liquidity_cutover
          (opening_amount, cutover_at, opname_high_water_id, stock_in_high_water_id,
           consignor_payment_high_water_id, take_profit_high_water_id)
        VALUES ('500000.0000', '2026-11-01 00:00:00.000', 0, 0, 0, 0)`);
      const rows = await rowsOf(
        `SELECT opening_amount, opening_unpaid_stock,
                CAST(stock_in_payment_high_water_id AS CHAR) AS payment_hw
           FROM liquidity_cutover`,
      );
      expect(rows.map((r) => [r.opening_amount, r.opening_unpaid_stock, r.payment_hw])).toEqual([
        ['500000.0000', '0.0000', '0'],
      ]);
    });

    it('accepts exactly one row (id = 1) and rejects a second', async () => {
      const { userId } = await seedUserAndStockIn();
      const insert = `INSERT INTO liquidity_cutover
          (id, opening_amount, cutover_at, opname_high_water_id, stock_in_high_water_id,
           consignor_payment_high_water_id, take_profit_high_water_id, created_by)
        VALUES (?, ?, '2026-11-01 00:00:00.000', 5, 7, 3, 2, ?)`;
      await run(insert, [1, '1250000.5000', userId]);
      await expectRejected(insert, [1, '1.0000', userId], 'ER_DUP_ENTRY');
      await expectRejected(insert, [2, '1.0000', userId], 'ER_CHECK_CONSTRAINT_VIOLATED');

      const rows = await rowsOf('SELECT id, opening_amount FROM liquidity_cutover');
      expect(rows.map((r) => [r.id, r.opening_amount])).toEqual([[1, '1250000.5000']]);
    });

    it('rejects a negative opening amount and an unknown user', async () => {
      const insert = `INSERT INTO liquidity_cutover
          (opening_amount, cutover_at, opname_high_water_id, stock_in_high_water_id,
           consignor_payment_high_water_id, take_profit_high_water_id, created_by)
        VALUES (?, '2026-11-01 00:00:00.000', 0, 0, 0, 0, ?)`;
      await expectRejected(insert, ['-0.0001', null], 'ER_CHECK_CONSTRAINT_VIOLATED');
      await expectRejected(insert, ['0.0000', 999999], 'ER_NO_REFERENCED_ROW_2');
      await run(insert, ['0.0000', null]);
    });
  });

  describe('liquidity_events', () => {
    it('stores a signed DECIMAL(20,4) delta with typed event and source columns', async () => {
      const cols = await columnsOf('liquidity_events');
      expectColumn(cols, 'id', 'bigint unsigned', 'NO');
      expectColumn(cols, 'amount_delta', 'decimal(20,4)', 'NO');
      expectColumn(
        cols,
        'event_type',
        "enum('opening','opname_inflow','stock_payment','consignor_payment','owner_withdrawal','reversal')",
        'NO',
      );
      expectColumn(
        cols,
        'source_type',
        "enum('cutover','opname','stock_in_payment','consignor_payment','take_profit')",
        'NO',
      );
      expectColumn(cols, 'source_id', 'bigint unsigned', 'NO');
      expectColumn(cols, 'effective_date', 'date', 'NO');
      expectColumn(cols, 'created_by', 'bigint unsigned', 'YES');
      expectColumn(cols, 'created_at', 'datetime(3)', 'NO');
      expectUtcDefault(cols, 'created_at');
    });

    it('accepts each event type with the sign it implies', async () => {
      const { userId } = await seedUserAndStockIn();
      await insertEvent('opening', 'cutover', 1, '1000000.0000', userId);
      await insertEvent('opname_inflow', 'opname', 1, '250000.0000', userId);
      await insertEvent('stock_payment', 'stock_in_payment', 1, '-50000.0000', userId);
      await insertEvent('consignor_payment', 'consignor_payment', 1, '-75000.0000', userId);
      await insertEvent('owner_withdrawal', 'take_profit', 1, '-100000.0000', userId);
      await insertEvent('reversal', 'take_profit', 1, '100000.0000', userId);
      await insertEvent('reversal', 'opname', 1, '-250000.0000', userId);

      const [sum] = await rowsOf('SELECT SUM(amount_delta) AS total FROM liquidity_events');
      expect(sum?.total).toBe('875000.0000');
    });

    it('rejects a delta whose sign contradicts the event type', async () => {
      const bad: [string, string, string][] = [
        ['opening', 'cutover', '-1.0000'],
        ['opname_inflow', 'opname', '0.0000'],
        ['opname_inflow', 'opname', '-1.0000'],
        ['stock_payment', 'stock_in_payment', '0.0000'],
        ['stock_payment', 'stock_in_payment', '1.0000'],
        ['consignor_payment', 'consignor_payment', '1.0000'],
        ['owner_withdrawal', 'take_profit', '1.0000'],
        ['reversal', 'take_profit', '0.0000'],
      ];
      for (const [eventType, sourceType, amount] of bad) {
        await expect(
          insertEvent(eventType, sourceType, 1, amount),
          `${eventType} ${amount}`,
        ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
      }
    });

    it('rejects an event type paired with the wrong source type', async () => {
      const bad: [string, string, string][] = [
        ['opening', 'opname', '1.0000'],
        ['opname_inflow', 'take_profit', '1.0000'],
        ['stock_payment', 'consignor_payment', '-1.0000'],
        ['consignor_payment', 'stock_in_payment', '-1.0000'],
        ['owner_withdrawal', 'opname', '-1.0000'],
        ['reversal', 'cutover', '-1.0000'],
      ];
      for (const [eventType, sourceType, amount] of bad) {
        await expect(
          insertEvent(eventType, sourceType, 1, amount),
          `${eventType}/${sourceType}`,
        ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
      }
    });

    it('allows only one event per source_type + source_id + event_type', async () => {
      await insertEvent('owner_withdrawal', 'take_profit', 42, '-10.0000');
      await expect(
        insertEvent('owner_withdrawal', 'take_profit', 42, '-10.0000'),
      ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      // Same source, different event (its reversal) and same id from another source are fine.
      await insertEvent('reversal', 'take_profit', 42, '10.0000');
      await insertEvent('consignor_payment', 'consignor_payment', 42, '-10.0000');
      await expect(insertEvent('reversal', 'take_profit', 42, '10.0000')).rejects.toMatchObject({
        code: 'ER_DUP_ENTRY',
      });
    });

    it('requires created_by to reference an existing user', async () => {
      await expect(
        insertEvent('opening', 'cutover', 1, '1.0000', 999999),
      ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    });

    it('stamps created_at in UTC by default', async () => {
      await insertEvent('opening', 'cutover', 1, '1.0000');
      const [row] = await rowsOf(
        `SELECT ABS(TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP(3))) AS drift
           FROM liquidity_events`,
      );
      expect(Number(row?.drift)).toBeLessThanOrEqual(5);
    });

    it('has a history index on (effective_date, id) and a unique source key', async () => {
      const rows = await rowsOf(
        `SELECT index_name AS idx, non_unique AS nu, column_name AS col
           FROM information_schema.statistics
          WHERE table_schema = ? AND table_name = 'liquidity_events'
          ORDER BY index_name, seq_in_index`,
        [SCRATCH],
      );
      const indexes = new Map<string, { unique: boolean; cols: string[] }>();
      for (const r of rows) {
        const entry = indexes.get(String(r.idx)) ?? { unique: Number(r.nu) === 0, cols: [] };
        entry.cols.push(String(r.col));
        indexes.set(String(r.idx), entry);
      }
      expect(indexes.get('idx_liquidity_events_history')).toEqual({
        unique: false,
        cols: ['effective_date', 'id'],
      });
      expect(indexes.get('uq_liquidity_events_source')).toEqual({
        unique: true,
        cols: ['source_type', 'source_id', 'event_type'],
      });
    });
  });

  describe('stock_in_payments', () => {
    it('has the payment columns and the same method enum as consignor_payments', async () => {
      const cols = await columnsOf('stock_in_payments');
      expectColumn(cols, 'id', 'bigint unsigned', 'NO');
      expectColumn(cols, 'stock_in_id', 'bigint unsigned', 'NO');
      expectColumn(cols, 'amount', 'decimal(20,4)', 'NO');
      expectColumn(cols, 'payment_date', 'date', 'NO');
      expectColumn(cols, 'note', 'text', 'YES');
      expectColumn(cols, 'idempotency_key', 'char(36)', 'NO');
      expectColumn(cols, 'created_by', 'bigint unsigned', 'YES');
      expectColumn(cols, 'created_at', 'datetime(3)', 'NO');
      expectUtcDefault(cols, 'created_at');

      const consignorCols = await columnsOf('consignor_payments');
      const method = String(cols.get('payment_method')?.type);
      expect(method).toBe("enum('cash','transfer','qris')");
      expect(method).toBe(String(consignorCols.get('payment_method')?.type));
      expect(cols.get('payment_method')?.nullable).toBe('NO');
    });

    it('accepts multiple partial settlements for one stock-in', async () => {
      const { userId, stockInId } = await seedUserAndStockIn();
      await insertStockInPayment(stockInId, '30000.0000', UUID_A, userId);
      await insertStockInPayment(stockInId, '20000.5000', UUID_B, userId);
      const [row] = await rowsOf(
        'SELECT COUNT(*) AS n, SUM(amount) AS total FROM stock_in_payments WHERE stock_in_id = ?',
        [stockInId],
      );
      expect([Number(row?.n), row?.total]).toEqual([2, '50000.5000']);
    });

    it('rejects a retried request with the same idempotency key', async () => {
      const { stockInId } = await seedUserAndStockIn();
      await insertStockInPayment(stockInId, '30000.0000', UUID_A);
      await expect(insertStockInPayment(stockInId, '30000.0000', UUID_A)).rejects.toMatchObject({
        code: 'ER_DUP_ENTRY',
      });
      await expect(
        insertStockInPayment(stockInId, '30000.0000', UUID_A.toUpperCase()),
      ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      const [row] = await rowsOf('SELECT COUNT(*) AS n FROM stock_in_payments');
      expect(Number(row?.n)).toBe(1);
    });

    it('requires a UUID-shaped idempotency key', async () => {
      const { stockInId } = await seedUserAndStockIn();
      await expect(insertStockInPayment(stockInId, '1.0000', null)).rejects.toMatchObject({
        code: 'ER_BAD_NULL_ERROR',
      });
      for (const key of ['', 'not-a-uuid', '3f2b8c1e4d5a4e6f9a7b0c1d2e3f4a5b', 'g'.repeat(36)]) {
        await expect(insertStockInPayment(stockInId, '1.0000', key), key).rejects.toMatchObject({
          code: 'ER_CHECK_CONSTRAINT_VIOLATED',
        });
      }
    });

    it('rejects a zero or negative amount', async () => {
      const { stockInId } = await seedUserAndStockIn();
      await expect(insertStockInPayment(stockInId, '0.0000', UUID_A)).rejects.toMatchObject({
        code: 'ER_CHECK_CONSTRAINT_VIOLATED',
      });
      await expect(insertStockInPayment(stockInId, '-1.0000', UUID_B)).rejects.toMatchObject({
        code: 'ER_CHECK_CONSTRAINT_VIOLATED',
      });
    });

    it('enforces stock_in and user foreign keys and protects paid stock-ins', async () => {
      const { stockInId } = await seedUserAndStockIn();
      await expect(insertStockInPayment(999999, '1.0000', UUID_A)).rejects.toMatchObject({
        code: 'ER_NO_REFERENCED_ROW_2',
      });
      await expect(
        insertStockInPayment(stockInId, '1.0000', UUID_A, 999999),
      ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });

      await insertStockInPayment(stockInId, '1.0000', UUID_A);
      await expectRejected('DELETE FROM stock_ins WHERE id = ?', [stockInId], 'ER_ROW_IS_REFERENCED_2');
    });
  });
});

describe('liquidity migration rollout (0013)', () => {
  it('applies onto existing 0001-0012 data without altering it and can be re-run', async () => {
    const names = (await readdir(REAL_DIR)).filter((n) => n.endsWith('.sql')).sort();
    for (const name of names.filter((n) => n !== LIQUIDITY_MIGRATION)) {
      await copyFile(path.join(REAL_DIR, name), path.join(dir, name));
    }
    await runMigrations(config, dir);

    await run(`UPDATE store_settings SET setting_value = '750000.0000'
                WHERE setting_key = 'min_working_capital'`);
    const stockIn = await run(
      `INSERT INTO stock_ins (type, date, note) VALUES ('purchase', '2026-10-01', 'before 0013')`,
    );
    const snapshot = async (): Promise<unknown> => ({
      settings: await rowsOf('SELECT setting_key, setting_value FROM store_settings ORDER BY 1'),
      stockIns: await rowsOf('SELECT id, type, date, note FROM stock_ins ORDER BY id'),
    });
    const before = await snapshot();

    await copyFile(path.join(REAL_DIR, LIQUIDITY_MIGRATION), path.join(dir, LIQUIDITY_MIGRATION));
    const result = await runMigrations(config, dir);
    expect(result.applied).toEqual([LIQUIDITY_MIGRATION]);
    expect(await snapshot()).toEqual(before);

    // Idempotent: running the raw file again (as if half-applied) must not fail or change data.
    const sql = await readFile(path.join(REAL_DIR, LIQUIDITY_MIGRATION), 'utf8');
    assertTestDatabase(SCRATCH);
    const c = await mysql.createConnection({ ...config, multipleStatements: true });
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
    expect(await snapshot()).toEqual(before);
    for (const table of LIQUIDITY_TABLES) {
      const [row] = await rowsOf(`SELECT COUNT(*) AS n FROM \`${table}\``);
      expect(Number(row?.n), table).toBe(0);
    }
    expect(stockIn.insertId).toBeGreaterThan(0);
  });
});
