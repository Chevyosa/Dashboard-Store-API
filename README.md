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
| `npm run migrate`       | Runner migrasi (diimplementasi di T-02)      |
| `npm audit --omit=dev`  | Audit dependency produksi                    |

## Catatan

- TypeScript dipatok `~6.0.3` karena `typescript-eslint` belum mendukung TypeScript 7.
- Test integrasi DB hanya boleh jalan di database berakhiran `_test` (guard dibuat di T-02).
