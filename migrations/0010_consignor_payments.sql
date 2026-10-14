CREATE TABLE IF NOT EXISTS consignor_payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  consignor_id BIGINT UNSIGNED NOT NULL,
  opname_id BIGINT UNSIGNED NULL,
  amount DECIMAL(20,4) NOT NULL,
  payment_date DATE NOT NULL,
  payment_method ENUM('cash', 'transfer', 'qris') NOT NULL DEFAULT 'cash',
  note TEXT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_consignor_payments_consignor FOREIGN KEY (consignor_id) REFERENCES consignors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_consignor_payments_opname FOREIGN KEY (opname_id) REFERENCES opnames(id) ON DELETE SET NULL,
  CONSTRAINT fk_consignor_payments_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_consignor_payments_consignor_id (consignor_id),
  INDEX idx_consignor_payments_opname_id (opname_id),
  INDEX idx_consignor_payments_date (payment_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
