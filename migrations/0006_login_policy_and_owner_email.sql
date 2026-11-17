-- SELLORA Additive Migration 0006: Progressive Login Lockout Policy Support
-- Preserves all existing users, orders, catalog, payments, and audit logs.
-- Tracks completed lockout_cycles in auth_login_throttles so progressive durations
-- (10m -> 15m -> 20m -> ... capped at LOGIN_MAX_LOCKOUT_SECONDS) persist across expired windows.

ALTER TABLE auth_login_throttles ADD COLUMN lockout_cycles INTEGER NOT NULL DEFAULT 0;
