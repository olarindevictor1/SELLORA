# SELLORA — Changelog

This log distinguishes verified workspace observations from earlier reported milestones.

---

## 2026-11-16 — Fail-Closed Login Lockout DB Handling & Production Configuration Preflight
- **Fail-Closed Lockout Enforcement (`src/server/security.ts`, `src/server/app.ts`)**:
  - Updated `checkLoginThrottle()` to query `lockout_cycles` and return `{ allowed: false, unavailable: true }` on DB/schema failures instead of `{ allowed: true }`.
  - Updated `recordFailedLoginAttempt()` to return `{ locked: true, unavailable: true }` on DB/schema failures instead of an unlocked result.
  - Updated `POST /api/auth/sign-in/email` to return safe sanitized HTTP `503` via `respondWithCapturedError()` whenever lockout checks or failure persistence cannot complete (zero SQL/path/error leakage).
- **Failure-Injection Tests & Preflight (`tests/sellora.test.ts`, `docs/PRODUCTION_LAUNCH_CHECKLIST.md`, `docs/SECURITY_BASELINE.md`)**:
  - Added failure-injection tests covering initial lockout check DB failure, failed-attempt write failure, unapplied `lockout_cycles` migration (`0006`), progressive `10m -> 15m -> 20m` lockouts, max cap, and reset on valid login / password reset.
  - Added explicit Production Configuration Preflight checklist covering Cloudflare `OWNER_EMAIL` & `ADMIN_NOTIFICATION_EMAIL` secrets, `LOGIN_MAX_LOCKOUT_SECONDS`, D1 `store_settings.email` fields, remote migrations `0004`–`0006`, and verified backup.

## 2026-11-16 — Admin Notification Email Configuration (`olarindevictor046@gmail.com`) & Deployment Preparation
- **Admin Notification Recipient Updated (`wrangler.toml`, `.env.example`, `worker/index.ts`, `server.ts`, `src/server/email.ts`, `src/components/admin/AdminSettingsTab.tsx`)**:
  - Updated `ADMIN_NOTIFICATION_EMAIL` and fallback defaults (`adminNotificationEmail`, `testEmailRecipient`, Admin Settings UI placeholders/defaults) from `olarindevictor3@gmail.com` to `olarindevictor046@gmail.com`.
  - Verified order notifications, new customer notices, and admin security alerts (owner email change, disputed login) route to `olarindevictor046@gmail.com`, while account lockout alerts, password resets, and customer/staff emails continue targeting their respective registered accounts.
- **Brevo Sender Configuration Preserved**: Kept `BREVO_FROM_EMAIL`, `BREVO_API_KEY`, `BREVO_FROM_NAME`, and transactional templates completely unchanged.
- **Tests**: Updated `tests/sellora.test.ts` and added an end-to-end notification-routing & sender-preservation suite (`31/31` local tests passing).

## 2026-11-16 — Admin Login Email Change & Progressive Login Lockout Policy Correction
- **Database Migration (`migrations/0006_login_policy_and_owner_email.sql`)**:
  - Added `lockout_cycles INTEGER NOT NULL DEFAULT 0` to `auth_login_throttles`.
- **Login-Attempt Security Policy (`src/server/security.ts`, `src/server/app.ts`, `src/server/auth.ts`, `wrangler.toml`, `worker/index.ts`, `server.ts`, `.env.example`)**:
  - Updated failed password attempt handling with per-email serialization (`withSignInEmailLock`): 1st failure records attempt (`401` generic response); 2nd consecutive failure triggers a **10-minute (`600s`) lockout**; each subsequent failure after lockout expires adds **+5 minutes (`+300s`) per completed lockout cycle** (`15m -> 20m -> 25m -> ...`) bounded by configurable `LOGIN_MAX_LOCKOUT_SECONDS` (default `3600s` = 60 minutes).
  - Lockout counters reset ONLY upon valid login or verified password reset (`onPasswordReset` + `account.update.after`), never upon expiry; already-locked attempts cannot extend `locked_until_ms` or increment `lockout_cycles`; deduplicated lockout alert emails prevent inbox flooding; Google OAuth remains isolated from password throttling.
- **Verified Administrator Email Migration (`src/server/auth.ts`, `src/server/routes/admin.ts`, `src/components/admin/AdminSettingsTab.tsx`, `scripts/provision-owner.ts`)**:
  - Updated designated `OWNER_EMAIL` to `olarindevictor046@gmail.com` while preserving `ADMIN_NOTIFICATION_EMAIL` (`olarindevictor3@gmail.com`) as an independent operational setting.
  - Enabled Better Auth `changeEmail` verification (`updateEmailWithoutVerification: false`) + owner-only `POST /api/admin/owner/change-email` with step-up auth (`requireRecentAuthSession`), duplicate check (`409`), stale Google OAuth link removal, other-session revocation, pre-migration hijack guard, and UI controls in Store Owner Identity.

## 2026-11-16 — Three-Layer Website Security Architecture & Interface Consolidation
- **Database Migration (`migrations/0005_three_layer_security.sql`)**:
  - Added Layer 2 persistence tables (`security_rate_limits`, `security_used_tokens`, `auth_login_throttles`).
  - Added Layer 3 security/monitoring tables (`error_monitoring_logs`, `security_events`, `login_history`, `known_user_devices`, `login_verification_tokens`, `developer_integrations`) and immutability trigger `trg_audit_logs_no_delete`.
- **Layer 1 & 2 Hardening (`src/server/security.ts`, `crypto.ts`, `app.ts`, `worker/index.ts`, `server.ts`, `routes/*`)**:
  - Added trusted Cloudflare Worker IP extraction (`cf-connecting-ip`), persistent D1/SQLite rate limiting across public/auth/checkout/upload/support/developer routes, persistent Turnstile single-use anti-replay, and progressive brute-force login throttling.
  - Enforced strict CORS allowlist, CSRF `Origin`/`Sec-Fetch-Site` checks, fail-closed `POST /api/webhooks/brevo` with `timingSafeEqualStr` + Zod, `X-Frame-Options`/`CSP`/`HSTS`/`Permissions-Policy`, upload magic-byte + `<svg>`/`<script>` polyglot rejection, sandboxed receipt downloads (`Content-Disposition: attachment`), Zod validation on remaining admin endpoints, and `requireRecentAuthSession` step-up checks.
- **Layer 3 Error Monitoring, Device Alerts & Developer Portal (`src/server/error-monitor.ts`, `login-monitor.ts`, `routes/security.ts`, `routes/developer.ts`, `email.ts`)**:
  - Added private `ERR-XXXXXXXX` error capture with secret/SQL redaction, 5-minute deduplication, and safe structured console fallback when DB writes fail.
  - Added `login_history` & `known_user_devices` tracking with `SEC-XXXXXXXX` alerts and single-use "This was me" / "This wasn't me" links that terminate all active user sessions on dispute, plus `/api/me/sessions` device management.
  - Added strictly isolated `/api/developer/*` endpoints authenticated exclusively via revocable, scoped, expiring SHA-256-hashed `slr_dev_...` Bearer keys.
- **Admin & Account UI Consolidation (`src/components/admin/AdminSettingsTab.tsx`, `CustomerAccountView.tsx`, `src/lib/api.ts`)**:
  - Removed duplicated settings sub-tabs (`delivery`, `email`, `appearance`) from `AdminSettingsTab.tsx`, added owner-only "Security & Support Access" management + customer active session controls, and surfaced clean `(Reference: ERR-...)` IDs without stack traces or internal logs.

## 2026-11-15 — Stage 2: Atomic D1 Batch Transactions & Database-Level Guards
- **Database Migration (`migrations/0004_atomic_checkout_guards.sql`)**:
  - Added database-level `RAISE(ABORT, ...)` triggers (`trg_variants_non_negative_stock`, `trg_coupons_validate_usage`, `trg_orders_validate_checkout`, `trg_order_items_validate_variant`, `trg_payment_evidence_block_confirmed`, `trg_payments_guard_transition`) so invalid writes, time-window/usage-limit violations, negative stock, invalid zones, or stale state transitions abort the entire batch inside SQLite/D1.
  - Added `idx_payment_evidence_r2_key` and `storage_orphan_records` table for compensating cleanup when R2 upload succeeds prior to a failed DB batch.
- **Backend Refactor (`src/server/db.ts`, `db-node.ts`, `orders.ts`, `admin.ts`, `customer.ts`, `owner-provisioning.ts`)**:
  - Replaced `db.transaction()` across all 13 call sites with `db.batch()` (`d1.batch()` on D1; `BEGIN IMMEDIATE ... COMMIT / ROLLBACK` on SQLite).
  - Enforced scalar `NOT NULL` subquery invariants for dependent inserts (`inventory_movements`, `order_status_history`), duplicate SKU/line aggregation in checkout & POS, relative `stock_quantity + ?` inventory adjustments, ISO 8601 `startsAt`/`expiresAt` normalization on coupons, compensating `storage.delete()` + `POST /api/admin/storage/cleanup-orphans`, and sanitized guard-code error mapping (`extractDbGuardCode`).
- **Verification**:
  - `npx tsc --noEmit` passed (`0` errors).
  - `npm test` passed `21/21` (13 baseline tests + Suites 1–8 covering SQLite unit guards, D1 `createD1Db` adapter binding order, transactional D1 shim integration, checkout rollback on invalid zone/coupon/stock/item/DB abort, coupon `starts_at`/`expires_at`/`max_uses`/`NULL` concurrency, inventory & payment verify/reject concurrency, POS orders, and injected failures / R2 orphan cleanup).
  - `npm run build` and Worker `esbuild` bundle check (`worker/index.ts`) passed.
  - **Scope Note**: `wrangler` CLI is unavailable in this container; remote Cloudflare D1 concurrency and live production deployment remain unverified until `0004` is applied on staging/pre-prod D1.

## 2026-11-15 — Workspace Recovery & Documentation Reorganization
- **Verified (Read-Only Inspection)**:
  - Audited entire `/app/applet` SELLORA workspace and confirmed 100% separation from other external projects.
  - Verified `.data/sellora.db` contains applied migrations `0001_initial.sql`, `0002_security_indexes.sql`, and `0003_seo_analytics.sql`.
  - Documented High-severity Cloudflare D1 non-atomic `transaction()` / checkout / coupon / POS / inventory issues and Medium-severity security hardening items.
  - Established `docs/PROJECT_OVERVIEW.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_BASELINE.md`, `docs/PRODUCTION_LAUNCH_CHECKLIST.md`, `docs/KNOWN_ISSUES.md`, and `docs/CHANGELOG.md`.

## Prior Session Milestones *(Reported & Previously Verified Locally; Re-Verification Scheduled After Stage 2)*
- **Optional Integrations Non-Blocking Fix**:
  - Updated `server.ts`, `worker/index.ts`, `wrangler.toml`, `src/server/security.ts`, `src/server/app.ts`, `src/server/routes/orders.ts`, `src/server/routes/public.ts`, `src/server/routes/admin.ts`, `src/server/seo.ts`, `src/lib/seo.ts`, and `src/lib/analytics.ts` so `GOOGLE_SITE_VERIFICATION`, `TURNSTILE_SECRET_KEY`, `VITE_TURNSTILE_SITE_KEY`, and `VITE_GA_MEASUREMENT_ID` are optional and non-blocking (13/13 tests and `tsc`/`vite build` reported passing prior to recovery turn).
- **Owner Auth Modernization**:
  - Removed manual `OWNER_BOOTSTRAP_SECRET` login flow; unified Better Auth Google OAuth and Email/Password onto the single authorized owner account (`olarindevictor3@gmail.com`) via `src/server/auth.ts`, `src/server/owner-provisioning.ts`, and `scripts/provision-owner.ts`.
- **Core Commerce, RBAC, Analytics, SEO, Workers/D1/R2 Migration**:
  - Implemented `migrations/0001_initial.sql`–`0003_seo_analytics.sql`, `worker/index.ts`, `wrangler.toml`, `docs/DEPLOYMENT.md`, `docs/ANDROID_CAPACITOR.md`, and `tests/sellora.test.ts`.
