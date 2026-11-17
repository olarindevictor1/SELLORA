# SELLORA — Architecture

**Last Verified Against Source:** 2026-11-17  
**Target Runtime:** Cloudflare Workers + Workers Static Assets + D1 + R2  
**Local Dev Runtime:** Node.js + Express (`server.ts`) + Vite + SQLite (`.data/sellora.db`) + Local File Storage (`.data/r2`)

---

## 1. System Architecture

```text
Browser / PWA / Capacitor WebView
   │
   ├── Static Assets (HTML/JS/CSS/Images)
   │     ├── Dev: Vite Middleware (`server.ts`) with SSR SEO injection (`renderSeoHtmlResponse`)
   │     └── Prod: Cloudflare Workers Static Assets (`env.ASSETS`, `run_worker_first` HTML SEO injection)
   │
   └── API Requests (`/api/*`) + Dynamic SEO (`/robots.txt`, `/sitemap.xml`)
         │
         ▼
   Hono Web-Standard API App (`src/server/app.ts`)
     ├── `/api/auth/*`      → Better Auth (`src/server/auth.ts`) + Turnstile Guard + Fail-Closed Login Throttle
     ├── `/api/webhooks/brevo` → Brevo webhook delivery-status receiver
     ├── `/api/*`           → Public (`public.ts`), Customer (`customer.ts`), Orders/Payments (`orders.ts`), Security (`security.ts`)
     ├── `/api/admin/*`     → RBAC + Planned Strict Admin Security Gate (Device/IP Lock + Admin Security Password) (`admin.ts`)
     └── `/api/developer/*` → Scoped `slr_dev_...` diagnostic portal routes (`developer.ts`)
         │
         ├── Database (`SelloraDb` interface — `src/server/db.ts`)
         │     ├── Dev: `createSqliteDb` (`src/server/db-node.ts` via `better-sqlite3`, WAL + FK ON; `db.batch()` uses `BEGIN IMMEDIATE ... COMMIT / ROLLBACK`)
         │     └── Prod: `createD1Db` (`src/server/db.ts` via `env.DB` D1 binding; `db.batch()` uses atomic `d1.batch()`)
         │
         ├── Object Storage (`SelloraStorage` interface)
         │     ├── Dev: `createLocalStorage` (`.data/r2/{products,receipts}/`)
         │     └── Prod: `createR2Storage` (`env.R2_MEDIA` private R2 bucket) + compensating delete & `storage_orphan_records`
         │
         └── External Integrations (Server-Side Only for Secrets)
               ├── Google OAuth 2.0 (via Better Auth, optional until credentials set)
               ├── Brevo SMTP API (`src/server/email.ts`, queued outbox in `email_notification_events`)
               ├── Cloudflare Turnstile (`siteverify`, active only when BOTH site + secret keys exist)
               └── Google Analytics 4 / Search Console (optional client/SEO head tags)
```

---

## 2. Database Schema & Migrations (`migrations/`)

All currency columns store integer **Nigerian Kobo** (`1 NGN = 100 kobo`), and timestamps use ISO 8601 UTC strings.

### Applied in Local Source (`0001`–`0006`)
1. **`migrations/0001_initial.sql`**
   - **Auth & RBAC**: `user` (includes `role`, `permissionsJson`, `isActive`, notification flags), `session`, `account`, `verification`
   - **Store Settings**: `store_settings` (`theme`, `bank_transfer`, `email`, `seo`)
   - **Catalog & Moderation**: `categories`, `collections`, `products` (`sku TEXT NOT NULL UNIQUE`, `price_kobo >= 0`, `status`), `product_variants` (`sku TEXT NOT NULL UNIQUE`, `stock_quantity >= 0` `CHECK`, `reserved_quantity >= 0`), `inventory_movements`, `reviews`, `product_questions`
   - **Commerce & Customers**: `addresses`, `delivery_zones`, `wishlists`, `carts` (`user_id` or `guest_token`), `coupons` (`discount_type`, `max_uses`, `used_count`), `newsletter_subscribers`
   - **Orders & Payments**: `orders` (with unique `order_number`, `idempotency_key`), `order_items` (`sku TEXT NOT NULL` historical snapshot), `order_status_history`, `payments`, `payment_evidence` (`receipt_r2_key`, `idempotency_key`)
   - **Operations & Audit**: `support_tickets`, `privacy_requests`, `expenses`, `email_notification_events` (`idempotency_key`), `email_delivery_attempts`, `audit_logs`
2. **`migrations/0002_security_indexes.sql`**
   - Non-destructive indexes: `idx_user_role`, `idx_account_provider_account`, `idx_audit_logs_action`.
3. **`migrations/0003_seo_analytics.sql`**
   - Additive SEO columns on `products` (`seo_canonical_url`, `seo_image_url`, `image_alt`) and `categories` (`seo_title`, `seo_description`), plus `analytics_events` (`page_view`, `view_item`, `add_to_cart`, `begin_checkout`).
4. **`migrations/0004_atomic_checkout_guards.sql`**
   - Database-level `RAISE(ABORT, ...)` triggers (`trg_variants_non_negative_stock`, `trg_coupons_validate_usage`, `trg_orders_validate_checkout`, `trg_order_items_validate_variant`, `trg_payment_evidence_block_confirmed`, `trg_payments_guard_transition`) so invalid mutations, stale transitions, negative stock, invalid zones, or coupon limit/time-window violations abort and roll back the entire D1/SQLite `batch()`.
   - `idx_payment_evidence_r2_key` index and `storage_orphan_records` table for failed compensating R2 deletions (`POST /api/admin/storage/cleanup-orphans`).
5. **`migrations/0005_three_layer_security.sql`**
   - Layer 2 tables: `security_rate_limits`, `security_used_tokens`, `auth_login_throttles`.
   - Layer 3 tables: `error_monitoring_logs`, `security_events`, `login_history`, `known_user_devices`, `login_verification_tokens`, `developer_integrations`, and immutable `trg_audit_logs_no_delete`.
6. **`migrations/0006_login_policy_and_owner_email.sql`**
   - Adds `lockout_cycles INTEGER NOT NULL DEFAULT 0` to `auth_login_throttles`.

### Additive Migration (`0007` — Implemented Locally)
7. **`migrations/0007_sku_and_strict_admin_security.sql`**
   - **SKU Integrity & Order-Reference Protection**:
     - Case-insensitive unique indexes (`idx_products_sku_nocase`, `idx_product_variants_sku_nocase`) and triggers preventing duplicate SKUs across `products`/`product_variants` as well as blocking silent `UPDATE` of `products.sku` or `product_variants.sku` once referenced in `order_items`.
   - **Separate Admin Security Password (`admin_security_credentials`)**:
     - Per-admin (`user_id PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE`) salted strong `scrypt` password hash (`N=16384, r=8, p=1, dkLen=64`) + `hash_params` metadata, `failed_attempts`, `lockout_cycles`, `locked_until_ms`, `password_updated_at`, and single-use hashed recovery code metadata.
   - **Trusted Admin Devices (`admin_trusted_devices`)**:
     - Complements `known_user_devices` (which retains legacy UA-summary compatibility) with server-issued cryptographic `device_token_hash`, `user_id`, `device_label`, `trusted_ip`, `is_trusted`, `revoked_at`, `created_at`, `last_used_at`.
   - **Strict Pending Approvals & Session Security State (`admin_login_approvals`, `admin_session_verifications`)**:
     - `admin_login_approvals`: records every strict-policy lock (`pending`, `approved`, `rejected`, `expired`), bound `session_id`, `user_id`, `device_token_hash`, `device_summary`, `ip_address`, `approx_location`, `trigger_reason` (`unfamiliar_device`, `unfamiliar_ip`, or `both`), hashed single-use short-lived approval/rejection tokens, `expires_at`, `decided_at`, `decided_by`. Expiry invalidates only the associated `session_id` without permanently locking the account.
     - `admin_session_verifications`: tracks `session_id PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE`, `user_id`, `approval_status` (`trusted` | `locked` | `approved` | `rejected`), `sec_password_verified_at`, `sec_password_expires_at`, `device_token_hash`, `ip_address`.

**Local Verification (`2026-11-16`):** Migrations `0001`–`0006` verified in local SQLite & test suite (`tests/sellora.test.ts`).  
**Remote Cloudflare D1 (`sellora-db`)**: Remote migration status and live Cloudflare D1 concurrency remain `UNVERIFIED` from this container (`wrangler` CLI absent; no remote deployment performed).

---

## 3. Storage Boundaries (`SelloraStorage`)

- `products/<filename>`: Publicly readable via `GET /api/media/products/:file` (filename sanitized via `/[^a-zA-Z0-9._-]/g`, immutable cache).
- `receipts/<order_id>/<evidence_id>.<ext>`: Private manual bank transfer evidence. Never served publicly; strictly gated by `GET /api/payments/evidence/:evidenceId/file` requiring an authenticated session matching `order.customer_id === user.id` or `payments:review` permission (`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`). On `POST /api/payments/:orderNumber/evidence`, if the D1 `batch()` aborts after object upload, a compensating `storage.delete()` runs and falls back to `storage_orphan_records` on failure.

---

## 4. Transactional Email Outbox (`src/server/email.ts`)

- Emails are queued idempotently into `email_notification_events` using deterministic `idempotency_key` values before calling Brevo `POST https://api.brevo.com/v3/smtp/email`.
- Failed or unconfigured sends record attempts in `email_delivery_attempts` and retry via exponential backoff (`processEmailOutbox`), runnable manually by admins or on Worker `scheduled()` events.
- **Planned Notification Types (Requirements B–D)**: `security_admin_approval_required` (sent to `OWNER_EMAIL` / `ADMIN_NOTIFICATION_EMAIL` with UTC & Lagos timestamps, device/IP info, and scanner-safe confirm landing URLs), `security_admin_approval_outcome`, `security_admin_password_changed`, and `security_admin_password_lockout`. Never include passwords, OTPs, or reusable session tokens in emails.

---

## 5. Planned Extension Architecture (Requirements A–E — Pending Implementation)

1. **Manual & Automatic SKU Lifecycle**:
   - Extend `POST /api/admin/products` to honor normalized manual `sku` (and optional `variantSku`) alongside automatic generation (`SLR-<PREFIX>-<ENTROPY>` / `<SKU>-V<N>`), returning HTTP `409` on duplicate conflicts.
   - Add `POST /api/admin/products/:id/variants` and `PATCH /api/admin/variants/:id` supporting manual/auto variant SKUs and guarding `sku` updates against `order_items` references.
   - Preserve `order_items.sku` snapshots across checkout and POS (`src/server/routes/orders.ts`, `admin.ts`).
2. **Two-Stage Privileged Admin Gate**:
   - For any authenticated user where `user.role !== 'customer'`, admin routes (`/api/admin/*`) and `GET /api/me` session status evaluate:
     1. **Strict Device + IP Gate**: Valid `HttpOnly; Secure; SameSite=Lax` device cookie matching an active `admin_trusted_devices` row **AND** matching `trusted_ip` (from `getTrustedClientIp`). Any mismatch creates/enforces a locked `admin_login_approvals` + `admin_session_verifications` state (HTTP `423`/`403` `ADMIN_SECURITY_LOCKED`) and dispatches the Gmail approval email.
     2. **Separate Admin Security Password Gate**: Once device/IP is trusted or explicitly approved for that specific pending request, the admin must pass `POST /api/admin/security/verify-password` (setting `sec_password_verified_at` and policy expiry on `admin_session_verifications`) before accessing Admin Dashboard data or mutations.
3. **Scanner-Safe Gmail Approval Flow**:
   - Email links point to `GET /api/security/admin-approval?token=<raw>&intent=approve|reject`, which validates token format without consuming it and serves a CSP-sandboxed HTML confirmation form.
   - Submitting the form invokes `POST /api/security/admin-approval` (`action=approve|reject`, `token`), atomically consuming the single-use hashed token, unlocking **only** that pending `session_id` (without bypassing the admin security password), or revoking the session & keeping locked on reject.

---

## 6. Known Architectural Notes

1. **D1 Batch Atomicity (`src/server/db.ts`)**: `db.transaction()` has been replaced across all write paths with `db.batch()`, backed by SQLite triggers and scalar `NOT NULL` subquery invariants (`0004_atomic_checkout_guards.sql`) so failed batches abort and roll back at the database engine level rather than relying on post-batch JS assertions.
2. **`public/robots.txt` vs Dynamic Route**: Static `public/robots.txt` sits alongside the dynamic `/robots.txt` Worker/Express route; `wrangler.toml` `run_worker_first` prioritizes the dynamic handler.
3. **Unused AI Flag**: `GEMINI_API_KEY` / `aiConfigured` exists in config interfaces and `/api/me`, with no active AI endpoints in `src/server/routes/`.

