-- Safe non-destructive migration: add RBAC and OAuth lookup indexes
-- Preserves all existing user, catalog, order, and migration records.

CREATE INDEX IF NOT EXISTS idx_user_role ON user(role);
CREATE INDEX IF NOT EXISTS idx_account_provider_account ON account(providerId, accountId);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at);
