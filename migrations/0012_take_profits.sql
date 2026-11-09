-- Migration 0012: Store Settings and Take Profit (Owner Withdrawals)
-- Supports working capital buffer configuration and owner take profit management.

CREATE TABLE IF NOT EXISTS store_settings (
  setting_key VARCHAR(64) PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO store_settings (setting_key, setting_value)
VALUES ('min_working_capital', '400000.0000');

CREATE TABLE IF NOT EXISTS take_profits (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  opname_id BIGINT UNSIGNED NULL,
  amount DECIMAL(20,4) NOT NULL,
  withdrawal_date DATE NOT NULL,
  payment_method ENUM('cash', 'transfer') NOT NULL DEFAULT 'cash',
  note TEXT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_take_profits_opname FOREIGN KEY (opname_id) REFERENCES opnames(id) ON DELETE SET NULL,
  CONSTRAINT fk_take_profits_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_take_profits_opname_id (opname_id),
  INDEX idx_take_profits_date (withdrawal_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
