-- Migration 0013: Store liquidity ledger.
-- Introduces an append-only, signed cash ledger (liquidity_events), the one-time
-- cutover snapshot of opening cash and opening obligations (liquidity_cutover),
-- and partial supplier settlements for purchase stock-ins (stock_in_payments).
-- Schema only: no business rows are seeded. All statements are re-runnable.
-- Requires MySQL >= 8.0.16 (enforced CHECK constraints, expression defaults).

-- Singleton cutover snapshot. It records two separate opening figures:
--   opening_amount       actual liquid cash physically on hand at cutover. This
--                        is the only figure seeded into the cash ledger (as the
--                        'opening' event); it must NOT be reduced by debts.
--   opening_unpaid_stock outstanding supplier debt at cutover for purchase
--                        receipts at or below stock_in_high_water_id. It is a
--                        liability, never cash, and never becomes a ledger event.
-- Every *_high_water_id is the highest source-row id whose effect is already
-- captured by those two figures; rows at or below it are historical and are
-- never projected or counted again. In particular, stock_in_payments rows at or
-- below stock_in_payment_high_water_id are already reflected in
-- opening_unpaid_stock; later payments against legacy receipts reduce it.
CREATE TABLE IF NOT EXISTS liquidity_cutover (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1,
  opening_amount DECIMAL(20,4) NOT NULL,
  opening_unpaid_stock DECIMAL(20,4) NOT NULL DEFAULT 0,
  cutover_at DATETIME(3) NOT NULL,
  opname_high_water_id BIGINT UNSIGNED NOT NULL,
  stock_in_high_water_id BIGINT UNSIGNED NOT NULL,
  stock_in_payment_high_water_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  consignor_payment_high_water_id BIGINT UNSIGNED NOT NULL,
  take_profit_high_water_id BIGINT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  CONSTRAINT chk_liquidity_cutover_singleton CHECK (id = 1),
  CONSTRAINT chk_liquidity_cutover_opening_nonneg CHECK (opening_amount >= 0),
  CONSTRAINT chk_liquidity_cutover_unpaid_stock_nonneg CHECK (opening_unpaid_stock >= 0),
  CONSTRAINT fk_liquidity_cutover_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_liquidity_cutover_created_by (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Partial (multiple) supplier settlements for a stock-in. Each request carries
-- a client-generated UUID so retries cannot double-pay.
CREATE TABLE IF NOT EXISTS stock_in_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stock_in_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(20,4) NOT NULL,
  payment_date DATE NOT NULL,
  payment_method ENUM('cash', 'transfer', 'qris') NOT NULL DEFAULT 'cash',
  note TEXT NULL,
  idempotency_key CHAR(36) NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  -- Column collation is case-insensitive, so upper/lower-case retries collide too.
  UNIQUE KEY uq_stock_in_payments_idempotency_key (idempotency_key),
  CONSTRAINT chk_stock_in_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT chk_stock_in_payments_idempotency_uuid CHECK (
    REGEXP_LIKE(idempotency_key, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'i')
  ),
  CONSTRAINT fk_stock_in_payments_stock_in FOREIGN KEY (stock_in_id) REFERENCES stock_ins(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_in_payments_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_stock_in_payments_stock_in_id (stock_in_id),
  INDEX idx_stock_in_payments_date (payment_date),
  INDEX idx_stock_in_payments_created_by (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only signed cash ledger. Liquid cash balance = SUM(amount_delta).
-- Holds cash movements only; obligations (unpaid stock, consignor payouts) are
-- derived from their source tables and never stored here.
-- source_id is polymorphic (refers to the table named by source_type), so it
-- carries no FK; uniqueness on (source_type, source_id, event_type) makes
-- projection from each source idempotent while still allowing one reversal.
CREATE TABLE IF NOT EXISTS liquidity_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type ENUM('opening', 'opname_inflow', 'stock_payment', 'consignor_payment', 'owner_withdrawal', 'reversal') NOT NULL,
  source_type ENUM('cutover', 'opname', 'stock_in_payment', 'consignor_payment', 'take_profit') NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  amount_delta DECIMAL(20,4) NOT NULL,
  effective_date DATE NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_liquidity_events_source (source_type, source_id, event_type),
  INDEX idx_liquidity_events_history (effective_date, id),
  INDEX idx_liquidity_events_created_by (created_by),
  -- Each event type belongs to exactly one source type; reversals may target
  -- any non-cutover source.
  CONSTRAINT chk_liquidity_events_source_match CHECK (
    (event_type = 'opening' AND source_type = 'cutover')
    OR (event_type = 'opname_inflow' AND source_type = 'opname')
    OR (event_type = 'stock_payment' AND source_type = 'stock_in_payment')
    OR (event_type = 'consignor_payment' AND source_type = 'consignor_payment')
    OR (event_type = 'owner_withdrawal' AND source_type = 'take_profit')
    OR (event_type = 'reversal' AND source_type <> 'cutover')
  ),
  -- Sign implied by the event: inflows positive, outflows negative, the
  -- opening balance non-negative, and a reversal opposite to what it undoes.
  CONSTRAINT chk_liquidity_events_sign CHECK (
    (event_type = 'opening' AND amount_delta >= 0)
    OR (event_type = 'opname_inflow' AND amount_delta > 0)
    OR (event_type IN ('stock_payment', 'consignor_payment', 'owner_withdrawal') AND amount_delta < 0)
    OR (event_type = 'reversal' AND source_type = 'opname' AND amount_delta < 0)
    OR (event_type = 'reversal' AND source_type IN ('stock_in_payment', 'consignor_payment', 'take_profit') AND amount_delta > 0)
  ),
  CONSTRAINT fk_liquidity_events_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
