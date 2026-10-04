import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';

export interface MigratorDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

interface MigrationFile {
  version: string;
  filename: string;
  checksum: string;
  sql: string;
}

interface AppliedRow extends RowDataPacket {
  version: string;
  filename: string;
  checksum: string;
}

const FILE_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const LOCK_NAME = 'store_schema_migrations';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  const seen = new Map<string, string>();

  for (const filename of names) {
    const match = FILE_PATTERN.exec(filename);
    const version = match?.[1];
    if (version === undefined) {
      throw new MigrationError(
        `Nama file migrasi tidak valid: ${filename} (format: NNNN_deskripsi.sql, huruf kecil).`,
      );
    }
    const clash = seen.get(version);
    if (clash !== undefined) {
      throw new MigrationError(`Nomor migrasi ganda ${version}: ${clash} dan ${filename}.`);
    }
    seen.set(version, filename);
    const sql = await readFile(path.join(dir, filename), 'utf8');
    files.push({ version, filename, checksum: sha256(sql), sql });
  }
  return files;
}

// Forward-only runner. DDL is not transactional in MySQL, so a migration is
// recorded only after its whole file ran successfully.
export async function runMigrations(
  config: MigratorDbConfig,
  dir: string,
  log: (message: string) => void = () => undefined,
): Promise<MigrationResult> {
  const files = await loadMigrationFiles(dir);

  // multipleStatements is enabled only here, for trusted .sql files from the repo.
  const conn = await mysql.createConnection({
    ...config,
    multipleStatements: true,
    timezone: 'Z',
    charset: 'utf8mb4',
    dateStrings: true,
  });

  try {
    const [lockRows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 30) AS got', [
      LOCK_NAME,
    ]);
    if (Number(lockRows[0]?.got) !== 1) {
      throw new MigrationError('Tidak bisa mengambil lock migrasi; proses lain sedang berjalan.');
    }

    try {
      return await applyPending(conn, files, log);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    await conn.end();
  }
}

async function applyPending(
  conn: mysql.Connection,
  files: MigrationFile[],
  log: (message: string) => void,
): Promise<MigrationResult> {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version CHAR(4) NOT NULL,
       filename VARCHAR(255) NOT NULL,
       checksum CHAR(64) NOT NULL,
       applied_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
       PRIMARY KEY (version),
       UNIQUE KEY uq_schema_migrations_filename (filename)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  );

  const [rows] = await conn.query<AppliedRow[]>(
    'SELECT version, filename, checksum FROM schema_migrations ORDER BY version',
  );
  const byVersion = new Map(files.map((f) => [f.version, f]));

  for (const row of rows) {
    const file = byVersion.get(row.version);
    if (file === undefined) {
      throw new MigrationError(
        `File migrasi hilang: ${row.filename} sudah diterapkan tetapi tidak ada di folder migrations.`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Checksum berubah untuk ${file.filename}: migrasi yang sudah diterapkan tidak boleh diedit. Buat migrasi baru.`,
      );
    }
  }

  const appliedVersions = new Set(rows.map((r) => r.version));
  const maxApplied = rows.length > 0 ? rows[rows.length - 1]?.version : undefined;
  const pending = files.filter((f) => !appliedVersions.has(f.version));

  for (const file of pending) {
    if (maxApplied !== undefined && file.version < maxApplied) {
      throw new MigrationError(
        `Migrasi ${file.filename} di luar urutan: versi ${maxApplied} sudah diterapkan lebih dulu.`,
      );
    }
  }

  const applied: string[] = [];
  for (const file of pending) {
    try {
      await conn.query(file.sql);
      await conn.execute(
        'INSERT INTO schema_migrations (version, filename, checksum) VALUES (?, ?, ?)',
        [file.version, file.filename, file.checksum],
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'kesalahan tidak diketahui';
      throw new MigrationError(`Migrasi ${file.filename} gagal: ${reason}`, { cause: err });
    }
    applied.push(file.filename);
    log(`applied  ${file.filename}`);
  }

  const skipped = files.filter((f) => appliedVersions.has(f.version)).map((f) => f.filename);
  for (const name of skipped) log(`skipped  ${name}`);
  return { applied, skipped };
}
