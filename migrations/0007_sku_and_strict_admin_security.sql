-- SELLORA Additive Migration 0007: Manual/Auto SKU Guards, Order-Reference Immutability,
-- Separate Admin Security Password, Strict Device/IP Policy & Scanner-Safe Approval Workflow
-- Non-destructive: preserves all existing data, triggers, users, catalog, and orders.

-- ==========================================
-- 1. SKU INTEGRITY & ORDER-REFERENCE PROTECTION
-- ==========================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_nocase
  ON products(UPPER(TRIM(sku)));

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_sku_nocase
  ON product_variants(UPPER(TRIM(sku)));

CREATE TRIGGER IF NOT EXISTS trg_products_sku_unique_insert
BEFORE INSERT ON products
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM product_variants WHERE UPPER(TRIM(sku)) = UPPER(TRIM(NEW.sku))
    )
    THEN RAISE(ABORT, 'SKU_ALREADY_EXISTS')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_products_sku_unique_update
BEFORE UPDATE OF sku ON products
FOR EACH ROW
WHEN UPPER(TRIM(NEW.sku)) != UPPER(TRIM(OLD.sku))
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM order_items
      WHERE product_id = OLD.id OR UPPER(TRIM(sku)) = UPPER(TRIM(OLD.sku))
    )
    THEN RAISE(ABORT, 'SKU_REFERENCED_BY_ORDER')
    WHEN EXISTS (
      SELECT 1 FROM product_variants WHERE UPPER(TRIM(sku)) = UPPER(TRIM(NEW.sku))
    )
    THEN RAISE(ABORT, 'SKU_ALREADY_EXISTS')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_variants_sku_unique_insert
BEFORE INSERT ON product_variants
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM products WHERE UPPER(TRIM(sku)) = UPPER(TRIM(NEW.sku))
    )
    THEN RAISE(ABORT, 'SKU_ALREADY_EXISTS')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_variants_sku_unique_update
BEFORE UPDATE OF sku ON product_variants
FOR EACH ROW
WHEN UPPER(TRIM(NEW.sku)) != UPPER(TRIM(OLD.sku))
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM order_items
      WHERE variant_id = OLD.id OR UPPER(TRIM(sku)) = UPPER(TRIM(OLD.sku))
    )
    THEN RAISE(ABORT, 'SKU_REFERENCED_BY_ORDER')
    WHEN EXISTS (
      SELECT 1 FROM products WHERE UPPER(TRIM(sku)) = UPPER(TRIM(NEW.sku))
    )
    THEN RAISE(ABORT, 'SKU_ALREADY_EXISTS')
  END;
END;

-- ==========================================
-- 2. SEPARATE ADMIN SECURITY PASSWORD
-- Calibrated KDF: scrypt (N=16384, r=8, p=1, dkLen=64, 16-byte CSPRNG salt)
-- ==========================================

CREATE TABLE IF NOT EXISTS admin_security_credentials (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL DEFAULT 'scrypt_N16384_r8_p1_dkLen64',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  lockout_cycles INTEGER NOT NULL DEFAULT 0,
  locked_until_ms INTEGER NOT NULL DEFAULT 0,
  recovery_code_hash TEXT,
  email_recovery_token_hash TEXT,
  email_recovery_expires_at TEXT,
  password_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ==========================================
-- 3. STRICT TRUSTED ADMIN DEVICES & IP REGISTRY
-- ==========================================

CREATE TABLE IF NOT EXISTS admin_trusted_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  device_token_hash TEXT NOT NULL,
  device_label TEXT NOT NULL,
  trusted_ip TEXT NOT NULL,
  approx_location TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  approved_via TEXT NOT NULL DEFAULT 'email_approval',
  revoked_at TEXT,
  revoked_by TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(user_id, device_token_hash, trusted_ip)
);

CREATE INDEX IF NOT EXISTS idx_admin_trusted_devices_lookup
  ON admin_trusted_devices(user_id, device_token_hash, trusted_ip, is_active);

-- ==========================================
-- 4. SESSION-BOUND APPROVALS & VERIFICATION STATE
-- Expiry/Rejection locks ONLY the bound session_id, never permanently locking the user account.
-- ==========================================

CREATE TABLE IF NOT EXISTS admin_login_approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  login_id TEXT,
  event_ref TEXT,
  trigger_reason TEXT NOT NULL CHECK(trigger_reason IN ('unfamiliar_device', 'unfamiliar_ip', 'unfamiliar_device_and_ip')),
  device_token_hash TEXT NOT NULL,
  device_summary TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  approx_location TEXT,
  approve_token_hash TEXT NOT NULL UNIQUE,
  reject_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_login_approvals_session
  ON admin_login_approvals(session_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_login_approvals_user
  ON admin_login_approvals(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_session_verifications (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  device_approval_status TEXT NOT NULL CHECK(device_approval_status IN ('trusted', 'pending', 'approved', 'rejected', 'expired')),
  approval_id TEXT REFERENCES admin_login_approvals(id) ON DELETE SET NULL,
  sec_password_verified_at TEXT,
  sec_password_expires_at TEXT,
  bound_device_token_hash TEXT NOT NULL,
  bound_ip TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_session_verif_user
  ON admin_session_verifications(user_id, updated_at DESC);
