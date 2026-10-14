import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, runMigrations } from '../../src/db/migrator.js';
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
    ]);
    const tables = await query(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = '${SCRATCH}'`,
    );
    expect(tables.map((t) => t.name).sort()).toEqual([
      'audit_log',
      'consignor_payments',
      'consignors',
      'loss_records',
      'opname_consignor_payouts',
      'opname_items',
      'opnames',
      'products',
      'schema_migrations',
      'sessions',
      'stock_in_lines',
      'stock_ins',
      'stock_returns',
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
