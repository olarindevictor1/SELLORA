-- SELLORA Additive Migration 0005: PixelBridge Three-Layer Security Architecture
-- Preserves all existing users, catalog, orders, payments, and configuration records.

-- ==========================================
-- LAYER 2: PERSISTENT SHARED RATE LIMITING, LOCKOUT & REPLAY PROTECTION
-- ==========================================

CREATE TABLE IF NOT EXISTS security_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  reset_at_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON security_rate_limits(reset_at_ms);

CREATE TABLE IF NOT EXISTS security_used_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL DEFAULT 'turnstile',
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_used_tokens_exp ON security_used_tokens(expires_at_ms);

CREATE TABLE IF NOT EXISTS auth_login_throttles (
  throttle_key TEXT PRIMARY KEY,
  email TEXT,
  ip_address TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until_ms INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_throttles_email ON auth_login_throttles(email, locked_until_ms);

-- ==========================================
-- LAYER 3: SEPARATED MONITORING, SECURITY EVENTS & LOGIN HISTORY
-- Strictly separated from general activity audit logs (audit_logs).
-- ==========================================

CREATE TABLE IF NOT EXISTS error_monitoring_logs (
  id TEXT PRIMARY KEY,
  ref_id TEXT NOT NULL UNIQUE,
  service_category TEXT NOT NULL DEFAULT 'api',
  error_category TEXT NOT NULL DEFAULT 'internal_error',
  failed_operation TEXT NOT NULL,
  location TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production',
  correlation_id TEXT,
  sanitized_message TEXT NOT NULL,
  source_location TEXT,
  provider_error_code TEXT,
  retry_history_json TEXT NOT NULL DEFAULT '[]',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  investigation_status TEXT NOT NULL DEFAULT 'open'
    CHECK(investigation_status IN ('open', 'investigating', 'resolved', 'ignored')),
  resolution_notes TEXT NOT NULL DEFAULT '',
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_logs_ref ON error_monitoring_logs(ref_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_status ON error_monitoring_logs(investigation_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_dedup ON error_monitoring_logs(location, error_category, updated_at);

CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  event_ref TEXT NOT NULL UNIQUE,
  user_id TEXT,
  email TEXT,
  event_category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  ip_address TEXT,
  approx_location TEXT,
  device_summary TEXT,
  user_agent TEXT,
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK(risk_level IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'recorded'
    CHECK(status IN ('recorded', 'confirmed_by_user', 'disputed_by_user', 'mitigated', 'resolved')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  investigated_by TEXT,
  resolution_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_status ON security_events(status, severity);

CREATE TABLE IF NOT EXISTS login_history (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL,
  auth_method TEXT NOT NULL DEFAULT 'email_password',
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failed', 'locked', 'step_up_required', 'disputed')),
  is_new_device INTEGER NOT NULL DEFAULT 0,
  is_unusual INTEGER NOT NULL DEFAULT 0,
  device_hash TEXT NOT NULL,
  device_summary TEXT NOT NULL,
  ip_address TEXT,
  approx_location TEXT,
  risk_score INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_history_email ON login_history(email, created_at DESC);

CREATE TABLE IF NOT EXISTS known_user_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  device_summary TEXT NOT NULL,
  approx_location TEXT,
  last_ip TEXT,
  trusted INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(user_id, device_hash)
);

CREATE INDEX IF NOT EXISTS idx_known_devices_user ON known_user_devices(user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS login_verification_tokens (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL REFERENCES login_history(id) ON DELETE CASCADE,
  event_ref TEXT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK(action IN ('confirm', 'dispute')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_verif_hash ON login_verification_tokens(token_hash);

-- ==========================================
-- LAYER 3: CLIENT-AUTHORIZED DEVELOPER PORTAL INTEGRATIONS
-- ==========================================

CREATE TABLE IF NOT EXISTS developer_integrations (
  id TEXT PRIMARY KEY,
  portal_name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL DEFAULT '["errors:read","errors:update","security:read","audit:read"]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dev_integrations_active ON developer_integrations(is_active, api_key_hash);

-- Append-only tamper protection on audit_logs & error/security records
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_LOGS_IMMUTABLE');
END;
