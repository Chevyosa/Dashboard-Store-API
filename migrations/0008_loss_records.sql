CREATE TABLE IF NOT EXISTS loss_records (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  qty_pcs INT UNSIGNED NOT NULL,
  reason ENUM('expired', 'damaged_on_display', 'damaged_before_display', 'lost', 'other') NOT NULL,
  borne_by ENUM('owner', 'consignor') NOT NULL,
  date DATE NOT NULL,
  note TEXT NULL,
  opname_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_loss_records_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  INDEX idx_loss_records_opname_id (opname_id),
  INDEX idx_loss_records_product_id (product_id),
  INDEX idx_loss_records_date (date),
  INDEX idx_loss_records_reason (reason),
  INDEX idx_loss_records_borne_by (borne_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
