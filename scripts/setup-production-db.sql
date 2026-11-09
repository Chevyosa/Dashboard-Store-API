-- =============================================================================
-- Febriyann Store: Production MySQL Database & Least-Privilege Users Setup
-- Run this as MySQL root user on the VPS:
--   mysql -u root -p < setup-production-db.sql
-- =============================================================================

-- 1. Create Production Database (UTF8MB4, UTC timezone handled by application)
CREATE DATABASE IF NOT EXISTS store_prod
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

-- 2. Create Migration User (DDL + DML permissions for running schema migrations)
-- REPLACE 'GANTI_PASSWORD_MIGRATOR_DI_SINI' with a strong generated password (>= 24 chars)
CREATE USER IF NOT EXISTS 'store_migrator'@'127.0.0.1'
  IDENTIFIED WITH caching_sha2_password BY 'GANTI_PASSWORD_MIGRATOR_DI_SINI';

CREATE USER IF NOT EXISTS 'store_migrator'@'localhost'
  IDENTIFIED WITH caching_sha2_password BY 'GANTI_PASSWORD_MIGRATOR_DI_SINI';

-- Grant DDL & DML permissions on store_prod only
GRANT ALL PRIVILEGES ON store_prod.* TO 'store_migrator'@'127.0.0.1';
GRANT ALL PRIVILEGES ON store_prod.* TO 'store_migrator'@'localhost';

-- 3. Create Application User (Strict Least Privilege: DML ONLY, NO DDL)
-- Cannot DROP, ALTER, CREATE tables. Even in the event of an injection vulnerability,
-- schema integrity and table structure cannot be dropped or altered by the app.
-- REPLACE 'GANTI_PASSWORD_APP_DI_SINI' with a strong generated password (>= 24 chars)
CREATE USER IF NOT EXISTS 'store_app'@'127.0.0.1'
  IDENTIFIED WITH caching_sha2_password BY 'GANTI_PASSWORD_APP_DI_SINI';

CREATE USER IF NOT EXISTS 'store_app'@'localhost'
  IDENTIFIED WITH caching_sha2_password BY 'GANTI_PASSWORD_APP_DI_SINI';

GRANT SELECT, INSERT, UPDATE, DELETE ON store_prod.* TO 'store_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON store_prod.* TO 'store_app'@'localhost';

FLUSH PRIVILEGES;

-- Verification query:
-- SELECT user, host, plugin FROM mysql.user WHERE user LIKE 'store_%';
