-- SELLORA Additive Migration 0004: Database-Level Atomic Guards & Storage Orphan Tracking
-- Enforces invariants inside D1/SQLite batch execution without altering existing rows.
-- Timestamps use strftime('%Y-%m-%dT%H:%M:%fZ', 'now') to match JS new Date().toISOString() lexicographically.

-- 1. Inventory guard: provide deterministic abort code when variant stock drops below zero
CREATE TRIGGER IF NOT EXISTS trg_variants_non_negative_stock
BEFORE UPDATE OF stock_quantity ON product_variants
FOR EACH ROW
WHEN NEW.stock_quantity < 0
BEGIN
  SELECT RAISE(ABORT, 'INSUFFICIENT_STOCK');
END;

-- 2. Coupon guard: enforce active status, starts_at, expires_at (NULL-safe), and max_uses (NULL-safe)
-- Fires only when used_count increases so admin deactivation/editing never fails.
CREATE TRIGGER IF NOT EXISTS trg_coupons_validate_usage
BEFORE UPDATE OF used_count ON coupons
FOR EACH ROW
WHEN NEW.used_count > OLD.used_count
BEGIN
  SELECT CASE
    WHEN NEW.is_active != 1 THEN RAISE(ABORT, 'COUPON_INACTIVE')
    WHEN NEW.starts_at IS NOT NULL AND NEW.starts_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN RAISE(ABORT, 'COUPON_NOT_STARTED')
    WHEN NEW.expires_at IS NOT NULL AND NEW.expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN RAISE(ABORT, 'COUPON_EXPIRED')
    WHEN NEW.max_uses IS NOT NULL AND NEW.used_count > NEW.max_uses THEN RAISE(ABORT, 'COUPON_LIMIT_EXCEEDED')
  END;
END;

-- 3. Order prerequisite guard: prevent order commit if delivery zone became disabled/deleted
-- or if an applied coupon code was deleted/invalidated between pre-read and batch commit.
CREATE TRIGGER IF NOT EXISTS trg_orders_validate_checkout
BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.delivery_zone_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM delivery_zones dz
           WHERE dz.id = NEW.delivery_zone_id AND dz.is_enabled = 1
         )
      THEN RAISE(ABORT, 'DELIVERY_ZONE_UNAVAILABLE')
    WHEN NEW.coupon_code IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM coupons c
           WHERE UPPER(c.code) = UPPER(NEW.coupon_code)
             AND c.is_active = 1
             AND (c.starts_at IS NULL OR c.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             AND (c.expires_at IS NULL OR c.expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             AND (c.max_uses IS NULL OR c.used_count <= c.max_uses)
         )
      THEN RAISE(ABORT, 'COUPON_INVALID')
  END;
END;

-- 4. Order item guard: ensure referenced product and variant remain active at batch commit
-- (POS orders allow draft/archived products as long as the variant row itself is active).
CREATE TRIGGER IF NOT EXISTS trg_order_items_validate_variant
BEFORE INSERT ON order_items
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  JOIN orders o ON o.order_id = NEW.order_id
  WHERE pv.id = NEW.variant_id
    AND pv.product_id = NEW.product_id
    AND pv.is_active = 1
    AND (o.source = 'pos' OR p.status = 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'VARIANT_UNAVAILABLE');
END;

-- 5. Payment evidence guard: reject evidence insertion if payment is missing or already confirmed
CREATE TRIGGER IF NOT EXISTS trg_payment_evidence_block_confirmed
BEFORE INSERT ON payment_evidence
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM payments p
      WHERE p.id = NEW.payment_id AND p.order_id = NEW.order_id
    ) THEN RAISE(ABORT, 'PAYMENT_NOT_FOUND')
    WHEN EXISTS (
      SELECT 1 FROM payments p
      WHERE p.id = NEW.payment_id AND p.status = 'payment_confirmed'
    ) THEN RAISE(ABORT, 'PAYMENT_ALREADY_CONFIRMED')
  END;
END;

-- 6. Payment state-machine guard: prevent concurrent verify races and invalid rejections/refunds
CREATE TRIGGER IF NOT EXISTS trg_payments_guard_transition
BEFORE UPDATE OF status ON payments
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.status = 'payment_confirmed' AND OLD.status = 'payment_confirmed'
      THEN RAISE(ABORT, 'PAYMENT_ALREADY_CONFIRMED')
    WHEN NEW.status = 'payment_confirmed' AND OLD.status NOT IN ('pending_payment', 'payment_under_review', 'payment_rejected')
      THEN RAISE(ABORT, 'INVALID_PAYMENT_STATE')
    WHEN NEW.status = 'payment_rejected' AND OLD.status NOT IN ('pending_payment', 'payment_under_review', 'payment_rejected')
      THEN RAISE(ABORT, 'CANNOT_REJECT_CONFIRMED_PAYMENT')
    WHEN NEW.status = 'payment_under_review' AND OLD.status = 'payment_confirmed'
      THEN RAISE(ABORT, 'PAYMENT_ALREADY_CONFIRMED')
    WHEN NEW.status = 'refund_pending' AND OLD.status = 'refunded'
      THEN RAISE(ABORT, 'INVALID_PAYMENT_STATE')
  END;
END;

-- 7. R2 receipt lookup index & durable orphan tracking table when compensating delete fails
CREATE INDEX IF NOT EXISTS idx_payment_evidence_r2_key ON payment_evidence(receipt_r2_key);

CREATE TABLE IF NOT EXISTS storage_orphan_records (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL DEFAULT 'receipts',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'deleted')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_storage_orphan_status ON storage_orphan_records(status, created_at);
