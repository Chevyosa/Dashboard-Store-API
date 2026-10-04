# Febriyann Store: Backend

Express + TypeScript + MySQL (raw SQL). Lihat `../AGENTS.md` untuk aturan proyek.

## Setup

```bash
nvm use            # Node 24.19.0 (.nvmrc)
npm ci
cp .env.example .env   # isi nilainya (jangan di-commit)
npm run dev
```

Husky memasang hook `pre-push` otomatis saat `npm ci` (typecheck + test).

## Perintah

| Perintah                | Fungsi                                       |
| ----------------------- | -------------------------------------------- |
| `npm run dev`           | Jalankan dengan auto-reload (tsx)            |
| `npm run build`         | Kompilasi ke `dist/`                         |
| `npm start`             | Jalankan hasil build                         |
| `npm run typecheck`     | Cek tipe                                     |
| `npm run lint`          | ESLint                                       |
| `npm run format:check`  | Cek format Prettier (`npm run format` tulis) |
| `npm test`              | Vitest (unit + integration)                  |
| `npm run test:watch`    | Vitest mode watch                            |
| `npm run test:coverage` | Test dengan coverage `src/domain`            |
| `npm run migrate`       | Terapkan migrasi ke `DB_NAME` (idempoten)    |
| `npm audit --omit=dev`  | Audit dependency produksi                    |

## Catatan

- TypeScript dipatok `~6.0.3` karena `typescript-eslint` belum mendukung TypeScript 7.
- Test integrasi memakai MySQL: database `store_test` (atau `TEST_DB_NAME`) harus sudah dibuat. Host, user, dan password dibaca dari `.env`; nama database test **wajib berakhiran `_test`**, kalau tidak test menolak jalan.
- Migrasi dimigrasikan otomatis ke database test sekali sebelum integration test. Test runner migrasi membuat dan menghapus database sementara `store_migrator_test` (butuh hak `CREATE`/`DROP`).

## Migrasi

- File: `migrations/NNNN_deskripsi.sql` (huruf kecil), **forward-only**. Jangan mengedit migrasi yang sudah diterapkan; buat file baru.
- Dicatat di tabel `schema_migrations` beserta checksum SHA-256. Checksum berubah, file hilang, atau nomor di luar urutan = gagal tegas (exit code 2).
- MySQL tidak punya DDL transaksional: migrasi dicatat hanya setelah seluruh file sukses. Jaga satu file tetap kecil agar mudah dipulihkan bila gagal di tengah.
- Kolom waktu memakai `UTC_TIMESTAMP(3)`, bukan `CURRENT_TIMESTAMP` (time zone MySQL lokal bisa bukan UTC).
