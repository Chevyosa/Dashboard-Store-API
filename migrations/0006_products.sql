CREATE TABLE IF NOT EXISTS products (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(191) NOT NULL,
  owner_type ENUM('own', 'consignor') NOT NULL,
  consignor_id BIGINT UNSIGNED NULL,
  pcs_per_pack INT UNSIGNED NOT NULL DEFAULT 1,
  sell_price DECIMAL(20,4) NOT NULL,
  margin_type ENUM('nominal', 'percent') NULL,
  margin_value DECIMAL(20,4) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_products_consignor FOREIGN KEY (consignor_id) REFERENCES consignors(id) ON DELETE RESTRICT,
  INDEX idx_products_owner_type (owner_type),
  INDEX idx_products_consignor_id (consignor_id),
  INDEX idx_products_is_active (is_active),
  INDEX idx_products_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
