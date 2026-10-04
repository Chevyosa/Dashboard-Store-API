import 'dotenv/config';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createDbPool } from '../src/config/db.js';
import { loadEnv } from '../src/config/env.js';
import { createAdmin, resetAdminPassword } from '../src/services/admin.service.js';
import { AppError } from '../src/utils/errors.js';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

// Reads a line without echoing it (the password never reaches the terminal or shell history).
function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((resolve) =>
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    }),
  );
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (!process.stdin.isTTY) {
    throw new AppError(
      400,
      'NO_PASSWORD',
      'Tidak ada terminal interaktif. Isi ADMIN_PASSWORD lewat environment.',
    );
  }
  const first = await askHidden('Password (min. 12 karakter): ');
  const second = await askHidden('Ulangi password: ');
  if (first !== second) throw new AppError(400, 'PASSWORD_MISMATCH', 'Password tidak sama.');
  return first;
}

const resetMode = process.argv.includes('--reset-password');
const pool = createDbPool(loadEnv());

try {
  const username = argValue('username') ?? process.env.ADMIN_USERNAME ?? (await ask('Username: '));
  const password = await readPassword();
  if (resetMode) {
    await resetAdminPassword(pool, { username, password });
    console.log(`Password "${username}" diganti dan semua sesinya dicabut.`);
  } else {
    await createAdmin(pool, { username, password });
    console.log(`Admin "${username}" dibuat.`);
  }
} catch (err) {
  console.error(err instanceof AppError ? err.message : 'Gagal menjalankan seed:admin.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
