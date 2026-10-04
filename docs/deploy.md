# Panduan Deployment Produksi: Febriyann Store

> **Target Lingkungan:** VPS Ubuntu (22.04 / 24.04 LTS), Cloud-First.
> **Domain Utama:** `store.febriyann.my.id`
> **Metode Proses:** PM2 + Nginx Reverse Proxy (dengan opsi Docker multi-stage).
> **Target Eksekutor:** Hermes (Autonomous Agent di VPS) atau System Administrator.

---

## 1. Arsitektur Jaringan & Alur Permintaan

```
Browser / Client (HTTPS:443)
              │
              ▼
    [ Nginx Reverse Proxy ]
    (SSL Let's Encrypt, HSTS, Gzip, Security Headers)
              │
     ┌────────┴────────┐
     ▼                 ▼
   Path: /          Path: /api/*  &  /health*
     │                 │
     ▼                 ▼
[ Next.js Frontend ] [ Express API Backend ]
(Port 127.0.0.1:3000) (Port 127.0.0.1:5050)
 (PM2: store-frontend) (PM2: store-backend)
                       │
                       ▼
                 [ MySQL 8+ ]
                 Database: store_prod
                 Users: store_app (DML) / store_migrator (DDL)
```

---

## 2. Prasyarat Sistem pada VPS

Pastikan paket dasar berikut telah terpasang di VPS:

- **OS:** Ubuntu 22.04 LTS atau 24.04 LTS
- **Node.js:** v24.x LTS (sesuai `.nvmrc`)
- **NPM:** v10.x atau lebih baru
- **MySQL Server:** 8.0+
- **Nginx & Certbot:** `nginx`, `certbot`, `python3-certbot-nginx`
- **PM2:** `npm install -g pm2`

### Skrip Instalasi Dependensi Sistem (Jalankan Sekali):

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx mysql-server

# Instal Node.js 24 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# Verifikasi versi
node -v   # Harus v24.x
npm -v    # Harus v10.x+

# Pasang PM2 global
sudo npm install -g pm2
```

---

## 3. Langkah Demi Langkah Deployment Perdana

### Langkah 3.1: Konfigurasi Firewall (UFW)

Hanya buka port SSH, HTTP, dan HTTPS:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

---

### Langkah 3.2: Setup Database Produksi & Least Privilege

Masuk ke konsol MySQL sebagai root:

```bash
sudo mysql
```

Eksekusi perintah SQL berikut (ganti password dengan string acak minimal 24 karakter):

```sql
-- 1. Buat database produksi
CREATE DATABASE IF NOT EXISTS store_prod
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

-- 2. Buat user migrasi (izin DDL + DML)
CREATE USER IF NOT EXISTS 'store_migrator'@'127.0.0.1' IDENTIFIED WITH caching_sha2_password BY 'PASSWORD_KUAT_MIGRATOR_DI_SINI';
CREATE USER IF NOT EXISTS 'store_migrator'@'localhost' IDENTIFIED WITH caching_sha2_password BY 'PASSWORD_KUAT_MIGRATOR_DI_SINI';
GRANT ALL PRIVILEGES ON store_prod.* TO 'store_migrator'@'127.0.0.1';
GRANT ALL PRIVILEGES ON store_prod.* TO 'store_migrator'@'localhost';

-- 3. Buat user aplikasi (izin DML saja, TANPA DDL)
CREATE USER IF NOT EXISTS 'store_app'@'127.0.0.1' IDENTIFIED WITH caching_sha2_password BY 'PASSWORD_KUAT_APP_DI_SINI';
CREATE USER IF NOT EXISTS 'store_app'@'localhost' IDENTIFIED WITH caching_sha2_password BY 'PASSWORD_KUAT_APP_DI_SINI';
GRANT SELECT, INSERT, UPDATE, DELETE ON store_prod.* TO 'store_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON store_prod.* TO 'store_app'@'localhost';

FLUSH PRIVILEGES;
EXIT;
```

---

### Langkah 3.3: Setup Direktori & Clone Repositori

Buat folder root aplikasi `/var/www/store`:

```bash
sudo mkdir -p /var/www/store
sudo chown -R $USER:$USER /var/www/store
cd /var/www/store

# Clone kedua repositori
git clone https://github.com/Chevyosa/Dashboard-Store-API.git backend
git clone https://github.com/Chevyosa/Dashboard-Store.git frontend
```

---

### Langkah 3.4: Setup Environment Backend

Buat file `/var/www/store/backend/.env`:

```bash
cat << 'EOF' > /var/www/store/backend/.env
NODE_ENV=production
PORT=5050
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=store_app
DB_PASSWORD=PASSWORD_KUAT_APP_DI_SINI
DB_NAME=store_prod
DB_CONNECTION_LIMIT=15

# Session secret (minimal 32 karakter acak)
SESSION_SECRET=GENERATE_STRING_ACAK_MINIMAL_32_KARAKTER_DI_SINI

# CORS & Domain
CORS_ORIGIN=https://store.febriyann.my.id
COOKIE_DOMAIN=store.febriyann.my.id
TRUST_PROXY=1
LOG_LEVEL=info
EOF
```

> **Catatan:** Ganti `PASSWORD_KUAT_APP_DI_SINI` dan `SESSION_SECRET` dengan nilai rahasia Anda. Amankan izin file:
>
> ```bash
> chmod 600 /var/www/store/backend/.env
> ```

---

### Langkah 3.5: Jalankan Migrasi Database & Buat Akun Admin

Migrasi dijalankan menggunakan kredensial `store_migrator` (user yang memiliki hak DDL):

```bash
cd /var/www/store/backend
npm ci --omit=dev=false

# Jalankan migrasi ke store_prod via store_migrator
DB_USER=store_migrator DB_PASSWORD=PASSWORD_KUAT_MIGRATOR_DI_SINI npm run migrate

# Buat akun admin pertama kali (interaktif, input password disembunyikan)
npm run seed:admin

# Build backend (kompilasi TypeScript ke dist/)
npm run build
```

---

### Langkah 3.6: Setup Environment & Build Frontend

Buat file `/var/www/store/frontend/.env.production`:

```bash
cat << 'EOF' > /var/www/store/frontend/.env.production
# Komunikasi internal Next.js Server Component ke Express lokal
API_URL=http://127.0.0.1:5050
EOF
```

Instal dependensi dan lakukan build Next.js:

```bash
cd /var/www/store/frontend
npm ci
npm run build
```

---

### Langkah 3.7: Menjalankan Aplikasi dengan PM2

Jalankan backend dan frontend menggunakan file konfigurasi PM2 yang sudah disediakan:

```bash
# Start backend
cd /var/www/store/backend
pm2 start ecosystem.config.cjs

# Start frontend
cd /var/www/store/frontend
pm2 start ecosystem.config.cjs

# Cek status
pm2 status

# Simpan state PM2 dan buat autostart systemd saat server reboot
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME
```

---

### Langkah 3.8: Konfigurasi Nginx & Penerbitan Sertifikat SSL

1. Buat direktori challenge Let's Encrypt:

   ```bash
   sudo mkdir -p /var/www/certbot
   ```

2. Pasang konfigurasi Nginx dari template:

   ```bash
   sudo cp /var/www/store/backend/docs/nginx.conf.example /etc/nginx/sites-available/store.febriyann.my.id
   sudo ln -sf /etc/nginx/sites-available/store.febriyann.my.id /etc/nginx/sites-enabled/

   # Hapus default jika ada
   sudo rm -f /etc/nginx/sites-enabled/default
   ```

3. Jalankan Certbot untuk mendapatkan sertifikat SSL Let's Encrypt:

   ```bash
   # Pastikan DNS A-Record store.febriyann.my.id sudah mengarah ke IP publik VPS!
   sudo certbot --nginx -d store.febriyann.my.id --non-interactive --agree-tos -m admin@febriyann.my.id --redirect
   ```

4. Uji konfigurasi Nginx dan reload:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

---

## 4. Checklist Verifikasi Pasca-Deployment

Eksekusi perintah berikut di terminal VPS untuk memastikan seluruh komponen beroperasi:

```bash
# 1. Cek endpoint kesehatan API Express
curl -fsS http://127.0.0.1:5050/health
# Ekspektasi: {"status":"ok"}

# 2. Cek konektivitas database dari aplikasi
curl -fsS http://127.0.0.1:5050/health/db
# Ekspektasi: {"status":"ok","db":"connected"}

# 3. Cek frontend lokal
curl -fsS -I http://127.0.0.1:3000/login
# Ekspektasi: HTTP/1.1 200 OK

# 4. Cek domain publik via HTTPS
curl -fsS -I https://store.febriyann.my.id/login
# Ekspektasi: HTTP/2 200, header HSTS, Set-Cookie security flags
```

Buka `https://store.febriyann.my.id` di browser, coba masuk menggunakan akun admin yang dibuat di Langkah 3.5.

---

## 5. Prosedur Pembaruan Rutin (Deploy Rilis Baru)

Saat ada pembaruan kode dari Git (`dev-master` / `main`), jalankan skrip berikut di VPS:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "== [1/4] Updating Backend =="
cd /var/www/store/backend
git pull origin dev-master
npm ci
npm run build

echo "== [2/4] Running Database Migrations =="
DB_USER=store_migrator DB_PASSWORD=PASSWORD_KUAT_MIGRATOR_DI_SINI npm run migrate

echo "== [3/4] Updating Frontend =="
cd /var/www/store/frontend
git pull origin dev-master
npm ci
npm run build

echo "== [4/4] Zero-Downtime Reload via PM2 =="
pm2 reload store-backend
pm2 reload store-frontend

echo "== Deploy Selesai! Verifikasi Health Check: =="
curl -fsS https://store.febriyann.my.id/health/db
echo ""
```

---

## 6. Prosedur Tanggap Darurat: Rollback

Jika rilis baru mengalami kendala di produksi:

```bash
# 1. Rollback Frontend ke commit sebelumnya
cd /var/www/store/frontend
git checkout HEAD~1
npm ci
npm run build
pm2 reload store-frontend

# 2. Rollback Backend ke commit sebelumnya
cd /var/www/store/backend
git checkout HEAD~1
npm ci
npm run build
pm2 reload store-backend

# 3. Periksa status log
pm2 logs --lines 50
```

> **Penting Mengenai Database:**
> Seluruh migrasi database bersifat **forward-only** (sesuai kontrak `AGENTS.md` §7). Jangan pernah melakukan DROP kolom/tabel secara destruktif tanpa migrasi perbaikan maju.
