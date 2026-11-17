# SELLORA — Production Launch Checklist

**Project:** SELLORA (`sellora-commerce`)  
**Policy:** A passing build or local test suite does **not** mean production-ready. All **Critical** and **High** findings in [`SECURITY_BASELINE.md`](./SECURITY_BASELINE.md) and [`SECURITY_AUDIT_REPORT.md`](./SECURITY_AUDIT_REPORT.md) must be verified on staging/production Cloudflare infrastructure before public launch.

---

## 1. Security & Integrity Gates (Code — Completed Locally; Remote Verification Pending)

- [x] **Stage 2 Atomic D1 Batch Transactions**: Replaced all 13 `db.transaction()` sites with atomic `db.batch()` (`d1.batch()` on D1; `BEGIN IMMEDIATE` on SQLite) + triggers & scalar `NOT NULL` subquery guards (`migrations/0004_atomic_checkout_guards.sql`) + R2 compensating delete & `storage_orphan_records` cleanup. *(Remote D1 verification pending rollout.)*
- [x] **Fail-Closed Webhook Security**: `POST /api/webhooks/brevo` returns `503` if `BREVO_WEBHOOK_SECRET` is unset, validates `x-brevo-secret` via `timingSafeEqualStr`, rate-limits, and validates payload with Zod.
- [x] **Upload Hardening & Sandboxed Downloads**: Receipt (`/payments/:orderNumber/evidence`) and media (`/admin/media/upload`) routes verify magic bytes matching declared MIME type and reject `<svg>`/`<html>`/`<script>` polyglots; receipt downloads enforce `Content-Disposition: attachment` and sandbox `CSP`.
- [x] **Persistent Rate Limiting & Brute-Force Protection**:
  - [x] D1/SQLite-backed `checkPersistentRateLimit()` applied across auth, checkout, tracking lookup, receipt upload, analytics, reviews, Q&A, coupons, newsletter, support, and `/api/developer/*`.
  - [x] Progressive brute-force login throttle (`auth_login_throttles`) with `429` + `Retry-After` and `SEC-XXXXXXXX` events.
  - [x] Turnstile anti-replay persisted in `security_used_tokens`.
  - [ ] Cloudflare WAF / Edge Rate Limiting rules configured in Cloudflare Dashboard for `/api/auth/*`, `/api/checkout`, `/api/payments/*`, and `/api/developer/*`.
  - [ ] Turnstile enabled for production (`TURNSTILE_SECRET_KEY` + `VITE_TURNSTILE_SITE_KEY`) with exact live hostname(s) registered.
- [x] **CSRF, CORS & HTTP Security Headers**: Origin/`Sec-Fetch-Site` enforcement, strict CORS allowlist, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control: no-store`, and HTTPS HSTS + Worker HTML CSP implemented locally.
  - [ ] Verify HSTS and CSP headers on live `APP_URL` after deployment.
- [x] **Admin Schema Validation & Layer 3 Architecture**: Zod validation added on remaining `admin.ts` write routes; step-up recent auth required for payouts/email/developer keys; private `ERR-XXXXXXXX` error monitoring (`error_monitoring_logs`), device login alerts (`login_history`, `known_user_devices`, `login_verification_tokens`), immutable `audit_logs`, and isolated `/api/developer/*` portal routes implemented.

---

## 2. Cloudflare Infrastructure & Secrets

- [ ] Worker `sellora-commerce` linked in `wrangler.toml` (`account_id = "af9c25c7647f2f2c551eab70be86b074"`, `main = "worker/index.ts"`).
- [ ] `GET https://<APP_URL>/api/health` returns `200`, and owner-authenticated `GET https://<APP_URL>/api/admin/infrastructure-status` returns `"runtime":"cloudflare-worker"`, `"database":"cloudflare-d1"`, `"storage":"cloudflare-r2"`.
- [ ] Mobile Capacitor builds (`android` / `ios`) built with `VITE_API_BASE_URL` pointing to exact live `<APP_URL>`.
- [ ] D1 `sellora-db` (`a6738474-f10d-4210-b8fe-194fab0e3bd8`) backup exported prior to applying migrations (`wrangler d1 export sellora-db --remote ...`).
- [ ] All SQL migrations (`0001_initial.sql`, `0002_security_indexes.sql`, `0003_seo_analytics.sql`, `0004_atomic_checkout_guards.sql`, `0005_three_layer_security.sql`, `0006_login_policy_and_owner_email.sql`) applied non-destructively to remote D1 and verified in `schema_migrations`, followed by staging/pre-prod D1 smoke tests.
- [ ] Private R2 bucket `sellora-media-private` verified (no public bucket listing/anonymous URL access; receipts accessed strictly via `/api/payments/evidence/:evidenceId/file`, product media uploaded/served/deleted via `/api/admin/media/*` and `/api/media/products/:file`).
- [ ] Production environment variables & Wrangler secrets configured (never committed to repo):
  - [ ] `APP_URL` set to exact live `https://` origin
  - [ ] `BETTER_AUTH_SECRET` (cryptographically random >= 32 chars)
  - [ ] `OWNER_EMAIL=olarindevictor046@gmail.com` & `ADMIN_NOTIFICATION_EMAIL=olarindevictor046@gmail.com`
  - [ ] `LOGIN_MAX_LOCKOUT_SECONDS=3600` (maximum progressive lockout cap)
  - [ ] `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`
  - [ ] `BREVO_API_KEY`, `BREVO_FROM_EMAIL` (verified sender/DKIM), `BREVO_WEBHOOK_SECRET`
  - [ ] `TURNSTILE_SECRET_KEY` & `VITE_TURNSTILE_SITE_KEY` (recommended before public launch)
  - [ ] Optional: `VITE_GA_MEASUREMENT_ID`, `GOOGLE_SITE_VERIFICATION`

---

## 3. Auth, Payment, Monitoring & Domain Verification

- [ ] Google Cloud OAuth 2.0 Web client verified with exact production Authorized JavaScript Origin (`<APP_URL>`) and Authorized Redirect URI (`<APP_URL>/api/auth/callback/google`).
- [ ] Owner (`olarindevictor046@gmail.com`) migrated via verified email-change links (if an existing `olarindevictor3@gmail.com` row exists on D1) or verified via Google OAuth / CLI-provisioned Email+Password (`npm run owner:provision -- --d1-sql`); confirm customer signups receive `role = 'customer'`.
- [ ] Test "This was me" and "This wasn't me" new-device alert links end-to-end once `BREVO_API_KEY` is active.
- [ ] *(Optional)* Generate scoped `slr_dev_...` key in Owner → Settings → Security & Support Access if integrating with an external developer support portal.
- [ ] Store bank account details configured in Admin → Settings, at least one active Nigerian State/LGA delivery zone enabled, and test order + receipt upload + admin payment verification tested end-to-end.
- [ ] Scheduled Cron (`[triggers]` in `wrangler.toml`) enabled or outbox retry strategy confirmed on target Workers plan.

---

## 4. Production Configuration Preflight *(Mandatory Before Every Deploy)*

Verify every item against live Cloudflare Workers & remote D1 (`sellora-db`) without blindly overwriting saved production values:

- [ ] **Verified Pre-Migration D1 Backup**: Exported and verified non-empty SQL backup (`npx wrangler d1 export sellora-db --remote --output=./backups/sellora-pre-deploy-$(date +%F).sql`) before running any remote migration.
- [ ] **Remote D1 Migrations (`0004`, `0005`, `0006`)**: Confirmed `0004_atomic_checkout_guards.sql`, `0005_three_layer_security.sql`, and `0006_login_policy_and_owner_email.sql` (`auth_login_throttles.lockout_cycles`) are applied on `sellora-db` (`npx wrangler d1 migrations list sellora-db --remote`) so fail-closed login security checks do not return `503`.
- [ ] **Cloudflare `OWNER_EMAIL` Secret / Variable**: Verified `OWNER_EMAIL` resolves to `olarindevictor046@gmail.com` (`npx wrangler secret list` — check whether a Worker secret overrides `wrangler.toml [vars]`).
- [ ] **Cloudflare `ADMIN_NOTIFICATION_EMAIL` Secret / Variable**: Verified `ADMIN_NOTIFICATION_EMAIL` resolves to `olarindevictor046@gmail.com` (check whether a Worker secret overrides `wrangler.toml [vars]`), while keeping `BREVO_FROM_EMAIL` / `BREVO_API_KEY` sender identity unchanged.
- [ ] **`LOGIN_MAX_LOCKOUT_SECONDS`**: Verified `LOGIN_MAX_LOCKOUT_SECONDS` is configured (default `"3600"` = 60 minutes) in Worker vars/secrets.
- [ ] **D1 Saved `store_settings` (`key = 'email'`)**: Inspected live `store_settings` JSON (`email.adminNotificationEmail` and `email.testEmailRecipient`) to confirm neither retains an outdated `olarindevictor3@gmail.com` override.

---

## 5. Build, Testing & Sign-Off

- [x] `npm run lint` (`tsc --noEmit`) verified locally with 0 errors.
- [x] `npm test` (`tsx --test tests/sellora.test.ts`) verified locally (all unit, D1 adapter, concurrency, failure-injection, fail-closed lockout DB error, SKU, privacy, and Three-Layer Security tests passing).
- [x] `npm run build` (`vite build`) and Worker bundle build verified locally.
- [ ] GitHub repository (`olarindevictor1/SELLORA`, branch `main`) synchronized without `.env`, `.data/`, `.db`, or `.zip` artifacts.
- [ ] Explicit **Functionality Approval** and **Security Approval** obtained from project owner before `wrangler deploy`.

