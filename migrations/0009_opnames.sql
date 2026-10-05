CREATE TABLE IF NOT EXISTS opnames (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  opname_date DATE NOT NULL UNIQUE,
  status ENUM('draft', 'final') NOT NULL DEFAULT 'draft',
  note TEXT NULL,
  total_turnover DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  total_sold_qty INT UNSIGNED NOT NULL DEFAULT 0,
  total_loss_qty INT UNSIGNED NOT NULL DEFAULT 0,
  total_cogs DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  total_payout_due DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_opnames_date (opname_date),
  INDEX idx_opnames_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS opname_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  opname_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  owner_type ENUM('own', 'consignor') NOT NULL,
  consignor_id BIGINT UNSIGNED NULL,
  -- Snapshots master
  product_name_snapshot VARCHAR(255) NOT NULL,
  sell_price_snapshot DECIMAL(20,4) NOT NULL,
  margin_type_snapshot ENUM('nominal', 'percent') NULL,
  margin_value_snapshot DECIMAL(20,4) NULL,
  pcs_per_pack_snapshot INT UNSIGNED NOT NULL DEFAULT 1,
  -- Data stok & mutasi
  opening_qty INT UNSIGNED NOT NULL DEFAULT 0,
  opening_value DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  in_qty INT UNSIGNED NOT NULL DEFAULT 0,
  in_cost DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  returned_qty INT UNSIGNED NOT NULL DEFAULT 0,
  expected_qty INT UNSIGNED NOT NULL DEFAULT 0,
  physical_qty INT UNSIGNED NOT NULL DEFAULT 0,
  diff_qty INT UNSIGNED NOT NULL DEFAULT 0,
  loss_qty INT UNSIGNED NOT NULL DEFAULT 0,
  sold_qty INT UNSIGNED NOT NULL DEFAULT 0,
  -- Hasil kalkulasi & costing
  avg_cost DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  cogs DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  own_loss_cost DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  closing_value DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  turnover DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  owner_margin_per_pcs DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  consignor_share_per_pcs DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  sold_share DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  loss_qty_owner_borne INT UNSIGNED NOT NULL DEFAULT 0,
  loss_compensation DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  payout_due DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_opname_items_opname FOREIGN KEY (opname_id) REFERENCES opnames(id) ON DELETE CASCADE,
  CONSTRAINT fk_opname_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  UNIQUE KEY uk_opname_product (opname_id, product_id),
  INDEX idx_opname_items_product_id (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS opname_consignor_payouts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  opname_id BIGINT UNSIGNED NOT NULL,
  consignor_id BIGINT UNSIGNED NOT NULL,
  sold_share DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  loss_compensation DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  payout_due DECIMAL(20,4) NOT NULL DEFAULT '0.0000',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_opname_payouts_opname FOREIGN KEY (opname_id) REFERENCES opnames(id) ON DELETE CASCADE,
  CONSTRAINT fk_opname_payouts_consignor FOREIGN KEY (consignor_id) REFERENCES consignors(id) ON DELETE RESTRICT,
  UNIQUE KEY uk_opname_consignor (opname_id, consignor_id),
  INDEX idx_opname_payouts_consignor_id (consignor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
