# SELLORA — Known Issues & Verification Gaps

**Last Updated:** 2026-11-15  
**Source of Truth:** Direct read-only source inspection of `/app/applet`

---

## 1. Confirmed Code Defects & Risks

| ID | Severity | Component | Description | Status |
| :--- | :--- | :--- | :--- | :--- |
| **ISS-001** | **High** | `src/server/db.ts`, `src/server/routes/orders.ts`, `migrations/0004_atomic_checkout_guards.sql` | Replaced `db.transaction()` pass-through with `db.batch()` (`d1.batch()` on D1; `BEGIN IMMEDIATE ... COMMIT / ROLLBACK` on SQLite) backed by SQL triggers and scalar `NOT NULL` subquery aborts (`0004_atomic_checkout_guards.sql`), plus compensating R2 delete & `storage_orphan_records`. | Resolved Locally *(Remote D1 verification pending staging/pre-prod rollout)* |
| **ISS-002** | **High** | `src/server/routes/orders.ts`, `src/server/routes/admin.ts`, `migrations/0004_atomic_checkout_guards.sql` | Coupon `starts_at` / `expires_at` / `max_uses` (`NULL` handled cleanly, UTC ISO 8601 comparison) now enforced inside SQL trigger `trg_coupons_validate_usage` and `trg_orders_validate_checkout`. | Resolved Locally *(Remote D1 concurrency verification pending)* |
| **ISS-003** | **High** | `src/server/routes/admin.ts`, `customer.ts`, `owner-provisioning.ts` | All remaining transaction call sites (`POS`, relative inventory adjust `stock_quantity + ?`, order status/ack/refund/payment verify/reject, product+variant create, customer addresses, owner provisioning) migrated to atomic `db.batch()` with DB-level guards. | Resolved Locally |
| **ISS-004** | **Medium** | `src/server/app.ts`, `src/server/crypto.ts` | `POST /api/webhooks/brevo` fails closed (`503`) if `BREVO_WEBHOOK_SECRET` is unset, validates `x-brevo-secret` via `timingSafeEqualStr`, rate-limits, and validates payload with Zod. | Resolved Locally |
| **ISS-005** | **Medium** | `src/server/app.ts`, `worker/index.ts`, `server.ts` | Added `Strict-Transport-Security` (on HTTPS), `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Permissions-Policy`, strict CORS allowlist, and CSRF origin/`Sec-Fetch-Site` enforcement. | Resolved Locally *(Live HTTPS verification pending deploy)* |
| **ISS-006** | **Medium** | `src/server/security.ts`, `orders.ts`, `public.ts`, `customer.ts`, `app.ts` | Replaced isolate-only buckets with persistent D1/SQLite `security_rate_limits` across auth, checkout, tracking, receipt upload, reviews, Q&A, coupons, support, newsletter, and developer API; added progressive `auth_login_throttles` lockout & `security_used_tokens` Turnstile anti-replay. | Resolved Locally *(Edge WAF rules recommended in Cloudflare Dashboard)* |
| **ISS-007** | **Medium** | `src/server/security.ts`, `orders.ts`, `admin.ts` | Added `validateUploadedFileBytes` (PNG/JPEG/WEBP/PDF/MP4 magic bytes + `<svg>`/`<html>`/`<script>` polyglot rejection) and `sanitizeUploadFilename`; receipts served with `Content-Disposition: attachment` + sandbox `CSP`. | Resolved Locally |
| **ISS-008** | **Medium** | `src/server/routes/admin.ts` | Added Zod validation across remaining `admin.ts` write routes (`PATCH /orders/:id/status`, `/products/:id`, `/reviews/:id`, `/delivery-zones/:id`) and step-up `requireRecentAuthSession` on payouts/email/developer keys. | Resolved Locally |
| **ISS-009** | **Medium** | `src/server/error-monitor.ts`, `app.ts`, `worker/index.ts`, `server.ts`, `email.ts` | Added Layer 3 private `error_monitoring_logs` (`ERR-XXXXXXXX`), secret redaction, 5-min deduplication, global `app.onError`, top-level Worker/Express error catchers, and sanitized `(Reference: ERR-...)` client display. | Resolved Locally |

---

## 2. Unverified Infrastructure & External Items

- **Local Git Repository**: `.git/` does not exist inside `/app/applet`; sync status with `olarindevictor1/SELLORA` (`main`) is **UNVERIFIED**.
- **Cloudflare Workers / D1 / R2 Production**: Live deployment of `sellora-commerce`, remote `sellora-db` migrations (including `0004_atomic_checkout_guards.sql`), real remote D1 `d1.batch()` edge concurrency, and `sellora-media-private` bucket policies are **UNVERIFIED** from this container (`wrangler` CLI is not installed here).
- **Third-Party Consoles**: Google Cloud OAuth client origins/URIs, Brevo sender DKIM, and Cloudflare Turnstile widget hostname bindings are external and **UNVERIFIED**.
- **Native Android App**: `capacitor.config.ts` exists; native `android/` project has not been generated or built.
- **Unused Config**: `GEMINI_API_KEY` / `aiConfigured` has no active backend route; `public/robots.txt` sits alongside the dynamic `/robots.txt` handler.
