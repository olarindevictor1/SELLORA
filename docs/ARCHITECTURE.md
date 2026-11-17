# SELLORA — Architecture

**Last Verified Against Source:** 2026-11-15  
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
     ├── `/api/auth/*`      → Better Auth (`src/server/auth.ts`) + Turnstile Guard (when both keys set)
     ├── `/api/webhooks/brevo` → Brevo webhook delivery-status receiver
     ├── `/api/*`           → Public (`public.ts`), Customer (`customer.ts`), Orders/Payments (`orders.ts`)
     └── `/api/admin/*`     → RBAC-protected admin routes (`admin.ts`)
         │
27:          ├── Database (`SelloraDb` interface — `src/server/db.ts`)
28:          │     ├── Dev: `createSqliteDb` (`src/server/db-node.ts` via `better-sqlite3`, WAL + FK ON; `db.batch()` uses `BEGIN IMMEDIATE ... COMMIT / ROLLBACK`)
29:          │     └── Prod: `createD1Db` (`src/server/db.ts` via `env.DB` D1 binding; `db.batch()` uses atomic `d1.batch()`)
30:          │
31:          ├── Object Storage (`SelloraStorage` interface)
32:          │     ├── Dev: `createLocalStorage` (`.data/r2/{products,receipts}/`)
33:          │     └── Prod: `createR2Storage` (`env.R2_MEDIA` private R2 bucket) + compensating delete & `storage_orphan_records`
34:          │
35:          └── External Integrations (Server-Side Only for Secrets)
36:                ├── Google OAuth 2.0 (via Better Auth, optional until credentials set)
37:                ├── Brevo SMTP API (`src/server/email.ts`, queued outbox in `email_notification_events`)
38:                ├── Cloudflare Turnstile (`siteverify`, active only when BOTH site + secret keys exist)
39:                └── Google Analytics 4 / Search Console (optional client/SEO head tags)
40: ```
41: 
42: ---
43: 
44: ## 2. Database Schema & Migrations (`migrations/`)
45: 
46: All currency columns store integer **Nigerian Kobo** (`1 NGN = 100 kobo`), and timestamps use ISO 8601 UTC strings.
47: 
48: 1. **`migrations/0001_initial.sql`**
49:    - **Auth & RBAC**: `user` (includes `role`, `permissionsJson`, `isActive`, notification flags), `session`, `account`, `verification`
50:    - **Store Settings**: `store_settings` (`theme`, `bank_transfer`, `email`, `seo`)
51:    - **Catalog & Moderation**: `categories`, `collections`, `products` (`price_kobo >= 0`, `status`), `product_variants` (`stock_quantity >= 0` `CHECK`, `reserved_quantity >= 0`), `inventory_movements`, `reviews`, `product_questions`
52:    - **Commerce & Customers**: `addresses`, `delivery_zones`, `wishlists`, `carts` (`user_id` or `guest_token`), `coupons` (`discount_type`, `max_uses`, `used_count`), `newsletter_subscribers`
53:    - **Orders & Payments**: `orders` (with unique `order_number`, `idempotency_key`), `order_items`, `order_status_history`, `payments`, `payment_evidence` (`receipt_r2_key`, `idempotency_key`)
54:    - **Operations & Audit**: `support_tickets`, `privacy_requests`, `expenses`, `email_notification_events` (`idempotency_key`), `email_delivery_attempts`, `audit_logs`
55: 2. **`migrations/0002_security_indexes.sql`**
56:    - Non-destructive indexes: `idx_user_role`, `idx_account_provider_account`, `idx_audit_logs_action`.
57: 3. **`migrations/0003_seo_analytics.sql`**
58:    - Additive SEO columns on `products` (`seo_canonical_url`, `seo_image_url`, `image_alt`) and `categories` (`seo_title`, `seo_description`), plus `analytics_events` (`page_view`, `view_item`, `add_to_cart`, `begin_checkout`).
59: 4. **`migrations/0004_atomic_checkout_guards.sql`**
60:    - Database-level `RAISE(ABORT, ...)` triggers (`trg_variants_non_negative_stock`, `trg_coupons_validate_usage`, `trg_orders_validate_checkout`, `trg_order_items_validate_variant`, `trg_payment_evidence_block_confirmed`, `trg_payments_guard_transition`) so invalid mutations, stale transitions, negative stock, invalid zones, or coupon limit/time-window violations abort and roll back the entire D1/SQLite `batch()`.
61:    - `idx_payment_evidence_r2_key` index and `storage_orphan_records` table for failed compensating R2 deletions (`POST /api/admin/storage/cleanup-orphans`).
62: 
63: **Local Verification (`2026-11-15`)**: Migrations `0001`–`0004` verified in local SQLite & transactional in-memory D1 shim tests (`21/21` tests passing in `tests/sellora.test.ts`).  
64: **Remote Cloudflare D1 (`sellora-db`)**: Remote migration status and live Cloudflare D1 concurrency remain `UNVERIFIED` from this container (`wrangler` CLI absent; no remote deployment performed).
65: 
66: ---
67: 
68: ## 3. Storage Boundaries (`SelloraStorage`)
69: 
70: - `products/<filename>`: Publicly readable via `GET /api/media/products/:file` (filename sanitized via `/[^a-zA-Z0-9._-]/g`, immutable cache).
71: - `receipts/<order_id>/<evidence_id>.<ext>`: Private manual bank transfer evidence. Never served publicly; strictly gated by `GET /api/payments/evidence/:evidenceId/file` requiring an authenticated session matching `order.customer_id === user.id` or `payments:review` permission (`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`). On `POST /api/payments/:orderNumber/evidence`, if the D1 `batch()` aborts after object upload, a compensating `storage.delete()` runs and falls back to `storage_orphan_records` on failure.
72: 
73: ---
74: 
75: ## 4. Transactional Email Outbox (`src/server/email.ts`)
76: 
77: - Emails are queued idempotently into `email_notification_events` using deterministic `idempotency_key` values before calling Brevo `POST https://api.brevo.com/v3/smtp/email`.
78: - Failed or unconfigured sends record attempts in `email_delivery_attempts` and retry via exponential backoff (`processEmailOutbox`), runnable manually by admins or on Worker `scheduled()` events.
79: 
80: ---
81: 
82: ## 5. Known Architectural Notes
83: 
84: 1. **D1 Batch Atomicity (`src/server/db.ts`)**: `db.transaction()` has been replaced across all 13 call sites with `db.batch()`, backed by SQLite triggers and scalar `NOT NULL` subquery invariants (`0004_atomic_checkout_guards.sql`) so failed batches abort and roll back at the database engine level rather than relying on post-batch JS assertions.
85: 2. **`public/robots.txt` vs Dynamic Route**: Static `public/robots.txt` sits alongside the dynamic `/robots.txt` Worker/Express route; `wrangler.toml` `run_worker_first` prioritizes the dynamic handler.
86: 3. **Unused AI Flag**: `GEMINI_API_KEY` / `aiConfigured` exists in config interfaces and `/api/me`, with no active AI endpoints in `src/server/routes/`.
