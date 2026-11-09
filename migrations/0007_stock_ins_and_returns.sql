CREATE TABLE IF NOT EXISTS stock_ins (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type ENUM('purchase', 'consignment_in', 'initial') NOT NULL,
  date DATE NOT NULL,
  note TEXT NULL,
  opname_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stock_ins_opname_id (opname_id),
  INDEX idx_stock_ins_date (date),
  INDEX idx_stock_ins_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_in_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stock_in_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  input_mode ENUM('pack', 'pcs') NOT NULL DEFAULT 'pcs',
  qty_pack INT UNSIGNED NULL,
  pcs_per_pack_snapshot INT UNSIGNED NOT NULL DEFAULT 1,
  qty_pcs INT UNSIGNED NOT NULL,
  total_cost DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_stock_in_lines_stock_in FOREIGN KEY (stock_in_id) REFERENCES stock_ins(id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_in_lines_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  INDEX idx_stock_in_lines_stock_in_id (stock_in_id),
  INDEX idx_stock_in_lines_product_id (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_returns (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  qty_pcs INT UNSIGNED NOT NULL,
  date DATE NOT NULL,
  note TEXT NULL,
  opname_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_stock_returns_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  INDEX idx_stock_returns_opname_id (opname_id),
  INDEX idx_stock_returns_product_id (product_id),
  INDEX idx_stock_returns_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
