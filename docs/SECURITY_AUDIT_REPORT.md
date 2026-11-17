# SELLORA — Three-Layer Security Audit Report

**Audit Date:** 2026-11-16  
**Audited Target:** `/app/applet` (`src/`, `worker/`, `server.ts`, `migrations/0001`–`0006`, `tests/sellora.test.ts`)  
**Reference Standard:** *PixelBridge Complete Three-Layer Website Security Standard* (Layers 1, 2 & 3)

---

## 1. Executive Summary

SELLORA is a single-store Nigerian e-commerce platform running on React, TypeScript, Vite, Hono, Better Auth, Cloudflare Workers/D1/R2 (and local Node/Express/SQLite). Following Stage 2 atomic database transaction hardening (`migrations/0004_atomic_checkout_guards.sql`) and Three-Layer Security architecture (`0005_three_layer_security.sql` + `0006_login_policy_and_owner_email.sql`), the platform enforces strict brute-force lockout protection, verified administrator email migration, **Layer 1 (Edge & Transport)**, **Layer 2 (Application & API Hardening)**, and **Layer 3 (Private Error Monitoring, Device Login Security & Client-Authorized Developer Integration)**.

All locally verifiable controls have automated test coverage in `tests/sellora.test.ts`. Items dependent on remote Cloudflare infrastructure (remote D1 migrations, Cloudflare Dashboard WAF rules, live HTTPS domain, and production Turnstile/Brevo/OAuth keys) are explicitly tracked as pending pre-launch verification in [`PRODUCTION_LAUNCH_CHECKLIST.md`](./PRODUCTION_LAUNCH_CHECKLIST.md).

---

## 2. Layer-by-Layer Control Mapping

### Layer 1: Infrastructure, Edge, Transport & Secrets
- **Trusted Edge IP Resolution (`src/server/security.ts`)**: `getTrustedClientIp` accepts Cloudflare-injected `cf-connecting-ip` on Workers while ignoring spoofable `x-forwarded-for`.
- **HTTPS & Security Headers (`src/server/app.ts`, `worker/index.ts`, `server.ts`)**: Enforces `Strict-Transport-Security` on HTTPS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Frame-Options: DENY` on API routes, `Cache-Control: no-store` on auth/admin/me/developer endpoints, and Worker/Node HTML CSP permitting configured Turnstile and Google Analytics origins.
- **Secret Hygiene**: Zero secrets exposed in `VITE_*` variables or client bundles; cryptographic helpers (`src/server/crypto.ts`) use Web Crypto SHA-256 (`sha256Hex`) and constant-time comparison (`timingSafeEqualStr`).

### Layer 2: Application, Auth, Upload & Database Hardening
- **Fail-Closed Brevo Webhook (`src/server/app.ts`)**: Returns `503` when `BREVO_WEBHOOK_SECRET` is unset; compares `x-brevo-secret` in constant time (`401` on mismatch), enforces rate limiting, and validates JSON shape via Zod.
- **CSRF & Strict CORS (`src/server/app.ts`)**: Enforces exact allowed origins (`APP_URL`, request origin/host, local dev origins) and blocks `Sec-Fetch-Site: cross-site` and mismatched `Origin`/`Referer` on cookie-backed mutations (`403`), while exempting non-cookie `/api/webhooks/*` and `/api/developer/*`.
- **Shared D1/SQLite Rate Limiting & Progressive Lockout Policy (`src/server/security.ts`, `src/server/app.ts`, `migrations/0005_three_layer_security.sql`, `migrations/0006_login_policy_and_owner_email.sql`)**:
  - `checkPersistentRateLimit` shares buckets across edge isolates via `security_rate_limits`.
  - Applied across auth, checkout, order tracking, receipt upload, analytics, reviews, Q&A, coupons, newsletter, support tickets, and developer API endpoints.
  - Progressive password login lockout (`auth_login_throttles` with `lockout_cycles` and `withSignInEmailLock` serialization):
    - 1st failed attempt: recorded, no lockout (`401` generic error).
    - 2nd consecutive failed attempt: **10-minute (`600s`) lockout** (`429` + `Retry-After` + deduplicated alert email).
    - 3rd+ failed attempt after prior lockout expires: adds **+5 minutes (`+300s`) per completed cycle** (`15m -> 20m -> 25m -> ...`), capped by `LOGIN_MAX_LOCKOUT_SECONDS` (default `3600s` = 60 minutes) to prevent indefinite account denial.
    - Counters reset ONLY on valid password sign-in or verified password reset (`onPasswordReset`), never on timer expiration; Google OAuth is unaffected.
    - Paired with IP-level throttling (`20` failed attempts in 15 min -> `300s`).
- **Verified Administrator Email Migration (`src/server/auth.ts`, `src/server/routes/admin.ts`)**:
  - `OWNER_EMAIL` updated to `olarindevictor046@gmail.com` while preserving owner account ID, permissions, and commerce history via Better Auth's verified `changeEmail` + `verify-email` workflow (`updateEmailWithoutVerification: false`), step-up authentication, duplicate checks (`409`), stale `google` OAuth unlinking, and other-session revocation.
- **Turnstile Single-Use Anti-Replay (`src/server/security.ts`)**: Persists verified token SHA-256 hashes in `security_used_tokens`.
- **Upload Magic-Byte Verification & Sandboxed Receipts (`src/server/security.ts`, `orders.ts`, `admin.ts`)**:
  - `validateUploadedFileBytes` validates binary file headers (PNG, JPEG, WEBP, PDF, MP4) and rejects `<svg>`, `<?xml`, `<!doctype html`, `<html>`, and `<script>` polyglot payloads.
  - `sanitizeUploadFilename` normalizes uploaded filenames; receipt downloads enforce `Content-Disposition: attachment` and `CSP: default-src 'none'; sandbox`.
- **Schema Validation & Step-Up Authentication (`src/server/routes/admin.ts`)**:
  - Zod validation on admin write endpoints; `requireRecentAuthSession()` (`<= 30 min`) enforced for `bank_transfer` payout details, `email` settings, owner login email changes, and developer integration key generation.
- **Atomic Concurrency & SQL Guards (`migrations/0004_atomic_checkout_guards.sql`)**: Preserved across all 13 batch write paths (`db.batch()`), preventing stock underflow, coupon overuse, or stale payment/order state races.

### Layer 3: Private Error Monitoring, Account Login Protection & Developer Portal Isolation
- **Private Error Monitoring (`src/server/error-monitor.ts`, `migrations/0005_three_layer_security.sql`)**:
  - Captures unhandled route/Worker/Express/email failures into `error_monitoring_logs` with unpredictable `ERR-XXXXXXXX` reference IDs.
  - Strips Bearer tokens, API/mail keys, cookies, passwords, and SQL/local file paths (`redactSensitiveText`, `sanitizeDiagnosticObject`).
  - Deduplicates identical unresolved errors within 5 minutes and degrades cleanly to a sanitized console JSON log if the database is unreachable.
  - Shoppers and store staff see only safe generic copy + `(Reference: ERR-XXXXXXXX)`.
- **New-Device Login Alerts & Self-Service Session Control (`src/server/login-monitor.ts`, `src/server/routes/security.ts`)**:
  - Tracks device summaries and approximate edge country/region (`login_history`, `known_user_devices`) without blocking travelers or mobile carrier IP changes.
  - Unrecognized devices or country changes trigger `SEC-XXXXXXXX` alerts and email single-use SHA-256 verification links (`login_verification_tokens`): confirming marks the device trusted; disputing ("This wasn't me") deletes all active `session` rows for that account, invalidates the paired token, escalates `security_events`, and notifies the store owner.
  - Customers and owners can inspect active sessions, revoke individual sessions, or sign out all other devices via `/api/me/sessions`.
- **Client-Authorized Developer Portal Integration (`src/server/routes/developer.ts`, `src/server/routes/admin.ts`)**:
  - Separate `/api/developer/*` namespace requires owner-issued `slr_dev_...` Bearer keys (SHA-256 hashed, expiring, revocable, least-privilege scopes: `errors:read`, `errors:update`, `security:read`, `security:update`, `audit:read`).
  - Rejects store session cookies (`401`) and cannot read customer orders, PII, bank details, or mutate store settings.
- **Immutable Audit Logs**: `trg_audit_logs_no_delete` blocks SQL `DELETE` on `audit_logs`.

---

## 3. Remaining External Dependencies

1. Remote Cloudflare D1 migration execution (`0004`, `0005`, `0006`) and remote concurrency smoke tests.
2. Live owner login email verification completion on remote D1 if an existing `olarindevictor3@gmail.com` owner row exists.
3. Cloudflare Dashboard WAF rate-limiting rules on edge routes.
4. Live production secrets provisioning (`BETTER_AUTH_SECRET`, `BREVO_WEBHOOK_SECRET`, `TURNSTILE_*`, `GOOGLE_*`, `BREVO_API_KEY`, `LOGIN_MAX_LOCKOUT_SECONDS`).
