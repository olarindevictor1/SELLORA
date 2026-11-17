# SELLORA — Security Baseline

**Last Audited:** 2026-11-16  
**Scope:** Application codebase in `/app/applet` (`src/`, `worker/`, `server.ts`, `migrations/`, `scripts/`)

Every future code or infrastructure change to SELLORA must be checked against this baseline before and after modification.

---

## 1. Verified Implemented Security Controls *(Source Inspection)*

| Domain | Control Verified in Code | Primary Location |
| :--- | :--- | :--- |
| **Authentication & Owner Guard** | Better Auth Email/Password (min 8 chars) & Google OAuth (`prompt=select_account`, `trustedProviders: ['google']`). Public signup for `OWNER_EMAIL` blocked (`403`) + recorded as a `high` security event; duplicate account creation for `OWNER_EMAIL` blocked while an owner exists; verified owner email change (`POST /api/admin/owner/change-email` / `/api/auth/change-email`) requires recent step-up auth, enforces uniqueness (`409`), requires email verification (`updateEmailWithoutVerification: false`), clears stale Google OAuth links, and revokes other sessions. | `src/server/auth.ts`, `src/server/app.ts`, `src/server/routes/admin.ts`, `src/server/owner-provisioning.ts` |
| **Brute-Force & Credential-Stuffing Throttle** | Persistent fail-closed `auth_login_throttles` (`lockout_cycles`) serialized via `withSignInEmailLock` enforces: 1st failed password login -> `401` (no lockout); 2nd consecutive failure -> **10-minute (`600s`) lockout**; subsequent failures after expiry add **+5 minutes (`+300s`) per cycle** (`15m -> 20m -> 25m -> ...`) up to configurable `LOGIN_MAX_LOCKOUT_SECONDS` (default `3600s` = 60 min). Returns safe HTTP `503` (via `respondWithCapturedError`, never bypassing auth) if `checkLoginThrottle` or `recordFailedLoginAttempt` fails due to DB/migration errors. Counters reset ONLY on valid password login or verified password reset (`onPasswordReset`). Google OAuth is unaffected by password lockouts. Generic copy prevents enumeration, emits `SEC-XXXXXXXX` alerts, sends deduplicated lockout notice emails, and pairs with IP burst throttling (`300s`). | `src/server/security.ts`, `src/server/app.ts`, `src/server/auth.ts`, `migrations/0005_three_layer_security.sql`, `migrations/0006_login_policy_and_owner_email.sql` |
| **CSRF & Strict CORS** | Mutating cookie-backed requests enforce exact `allowedOrigins` (`Origin` / `Referer`) and reject `Sec-Fetch-Site: cross-site` (`403`). Exempts explicit non-cookie endpoints (`/api/webhooks/*`, `/api/developer/*`). | `src/server/app.ts` |
| **HTTP Security Headers & CSP** | Enforces `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Frame-Options: DENY` (API), `Strict-Transport-Security` on HTTPS, `Cache-Control: no-store` on auth/admin/me/developer responses, and Worker/Node HTML CSP permitting Turnstile & GA. | `src/server/app.ts`, `worker/index.ts`, `server.ts` |
| **Trusted Client IP & Shared Rate Limits** | `getTrustedClientIp` honors edge-injected `cf-connecting-ip` on Workers while ignoring spoofable `x-forwarded-for`. `checkPersistentRateLimit` stores shared counters in D1/SQLite (`security_rate_limits`) across auth, checkout, tracking, receipt upload, analytics, reviews, Q&A, coupons, newsletter, support, and `/api/developer/*`. | `src/server/security.ts`, `migrations/0005_three_layer_security.sql` |
| **Turnstile Anti-Replay** | When both `TURNSTILE_SECRET_KEY` and `VITE_TURNSTILE_SITE_KEY` are set, verifies against Cloudflare `siteverify` and persists single-use SHA-256 digests in `security_used_tokens` (+ memory cache). | `src/server/security.ts` |
| **Upload Magic Bytes & Sandboxed Receipts** | `validateUploadedFileBytes` inspects file headers (PNG/JPEG/WEBP/PDF/MP4) and rejects `<svg>`, `<?xml`, `<!doctype html`, `<html>`, and `<script>` polyglots across receipts (`orders.ts`) and media (`admin.ts`). Receipts download with `Content-Disposition: attachment` and `CSP: default-src 'none'; sandbox`. | `src/server/security.ts`, `src/server/routes/orders.ts`, `src/server/routes/admin.ts` |
| **Server-Side RBAC & Step-Up Auth** | Every `/api/admin/*` route checks session auth + role + `requirePerm()`. High-risk owner actions (`bank_transfer` payout config, `email` settings, owner login email change, developer key generation) enforce `requireRecentAuthSession()` (`<= 30 min`). | `src/server/routes/admin.ts`, `src/server/security.ts` |
| **Atomic Data Integrity & R2 Compensation** | All 13 transactional write paths use `db.batch()` (`d1.batch()` on D1; `BEGIN IMMEDIATE` on SQLite) enforced by triggers & scalar `NOT NULL` subquery aborts (`0004_atomic_checkout_guards.sql`), plus `storage.delete()` + `storage_orphan_records` cleanup. | `src/server/db.ts`, `migrations/0004_atomic_checkout_guards.sql`, `orders.ts`, `admin.ts` |
| **Fail-Closed Brevo Webhook** | `POST /api/webhooks/brevo` returns `503` if `BREVO_WEBHOOK_SECRET` is unset, validates `x-brevo-secret` with constant-time `timingSafeEqualStr`, rate-limits, and validates payload with Zod. | `src/server/app.ts`, `src/server/crypto.ts` |
| **Layer 3 Private Error Monitoring** | Unexpected 500s (`app.onError`, top-level `worker/index.ts`, `server.ts`, email dispatch) record sanitized summaries in `error_monitoring_logs` with `ERR-XXXXXXXX` IDs, secret/SQL redaction, 5-minute deduplication, and safe structured console fallback on DB failure. Shoppers/admins only see generic text + `(Reference: ERR-XXXXXXXX)`. | `src/server/error-monitor.ts`, `src/lib/api.ts`, `src/server/email.ts` |
| **Layer 3 Login Monitoring & Session Hygiene** | `login_history` & `known_user_devices` track devices without locking out mobile/VPN IP changes. New-device or country-shifted logins trigger `SEC-XXXXXXXX` events and single-use SHA-256 `confirm` ("This was me") / `dispute` ("This wasn't me") email links; disputing deletes all `session` rows for that account immediately. Self-service session management is available at `/api/me/sessions`. | `src/server/login-monitor.ts`, `src/server/routes/security.ts`, `src/components/CustomerAccountView.tsx`, `src/components/admin/AdminSettingsTab.tsx` |
| **Layer 3 Isolated Developer Portal API** | `/api/developer/*` accepts only revocable, expiring, SHA-256-hashed `slr_dev_...` Bearer keys issued by the store owner (`developer_integrations`), rejects store cookies, enforces granular scopes (`errors:read`, `errors:update`, `security:read`, `security:update`, `audit:read`), and cannot access customer orders, PII, or store mutations. | `src/server/routes/developer.ts`, `src/server/routes/admin.ts` |
| **Immutable Audit Logs** | `trg_audit_logs_no_delete` aborts SQL `DELETE FROM audit_logs`. | `migrations/0005_three_layer_security.sql` |

---

## 2. External & Remote Verification Items *(Pending Cloudflare Rollout)*

1. **Remote D1 Migrations (`0004`, `0005` & `0006`) & Edge Verification**: `migrations/0004_atomic_checkout_guards.sql`, `migrations/0005_three_layer_security.sql`, and `migrations/0006_login_policy_and_owner_email.sql` must be applied to remote `sellora-db` after taking a D1 export backup, and verified with staging smoke tests.
2. **Verified Live Owner Email Migration**: After deploying `OWNER_EMAIL=olarindevictor046@gmail.com` and `ADMIN_NOTIFICATION_EMAIL=olarindevictor046@gmail.com`, complete the two-step verified email-change links if an existing owner row under `olarindevictor3@gmail.com` is present on remote D1.
3. **Cloudflare Edge WAF & Rate Limiting Rules**: Add Cloudflare Dashboard WAF rate-limiting rules on `/api/auth/*`, `/api/checkout`, `/api/payments/*`, and `/api/developer/*` in front of the Worker as Layer 1 defense-in-depth.
4. **Production Secrets & Lockout Cap**: Configure `BETTER_AUTH_SECRET`, `BREVO_WEBHOOK_SECRET`, `TURNSTILE_SECRET_KEY`, `VITE_TURNSTILE_SITE_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `LOGIN_MAX_LOCKOUT_SECONDS` (default `3600`) via Wrangler before public launch.
5. **Unused `GEMINI_API_KEY` Flag**: Keep unset/removed unless an explicitly approved server-side AI feature with cost & prompt-injection controls is added later.

---

## 3. Rules for Every Code Change

Before modifying SELLORA:
1. Check whether auth, RBAC, CSRF, uploads, D1 batch transactions, webhooks, error monitoring, or `/api/developer/*` scope isolation are affected.
2. Never return raw `err.message`, stack traces, SQL, or tokens in public/admin HTTP responses — route unexpected errors through `respondWithCapturedError()`.
3. Keep `error_monitoring_logs` and raw security telemetry out of shopper/admin UI; expose only sanitized references (`ERR-...` / `SEC-...`) or owner-level summaries.
4. Add or update unit/integration/security tests in `tests/sellora.test.ts` and update [`SECURITY_BASELINE.md`](./SECURITY_BASELINE.md) and [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).

