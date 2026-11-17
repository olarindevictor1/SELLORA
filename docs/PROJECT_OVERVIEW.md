# SELLORA — Project Overview

**Tagline:** Commerce without limits.  
**Last Verified Against Source:** 2026-11-17  
**Current Project Status:** `IN PROGRESS / INCOMPLETE` (Local codebase operational; confirmed Security & SKU specification extensions A–E documented pending implementation; remote Cloudflare D1/Worker deployment not yet verified)

---

## 1. Purpose & Scope

SELLORA is a single-store Nigerian ecommerce platform with a customer storefront and an administrative store-management console, operating exclusively in **Nigerian Naira (`NGN`, stored as integer `kobo` in SQLite/D1)**.

SELLORA is an independent brand and codebase. It is completely separate from any other store or brand and must never share credentials, databases, storage buckets, or branding.

---

## 2. Brand Identity *(Verified — Source Inspection)*

| Token | Value | Usage |
| :--- | :--- | :--- |
| Primary Navy | `#172554` | Headers, primary buttons, brand chrome |
| Accent Lime | `#B7F36B` | Primary CTAs, highlights, badges |
| White | `#FFFFFF` | Cards, surfaces |
| Cloud Background | `#F5F7F4` | Page background (`index.html`, `App.tsx`) |
| Slate | `#64748B` | Secondary labels & metadata |
| Ink | `#1E293B` | Primary body copy |
| Coral | `#F47B68` | Alerts & warnings |
| Display Font | `Plus Jakarta Sans` | Headings |
| Body & Numeric Font | `Inter` | Navigation, body text, NGN pricing |

---

## 3. Core Capabilities *(Classified by Verification Basis)*

### Implemented & Verified Locally *(Source Inspection + Prior Local Build/Tests)*
- **Better Auth Authentication (`src/server/auth.ts`, `src/server/app.ts`)**:
  - Customer email/password signup & login (`role = 'customer'` forced server-side; self-update role escalation stripped).
  - Unified store-owner authentication (`OWNER_EMAIL`, default `olarindevictor046@gmail.com`; `ADMIN_NOTIFICATION_EMAIL` default `olarindevictor046@gmail.com`) via Email/Password or verified Google OAuth (`emailVerified = 1` required), with verified email-change protection and progressive login throttling (`2` attempts -> `10m`, `+5m` per subsequent cycle, capped at `LOGIN_MAX_LOCKOUT_SECONDS`), without legacy manual bootstrap secrets.
  - Public signup for `OWNER_EMAIL` rejected (`403`).
- **RBAC Enforcement (`src/server/routes/admin.ts`, `src/shared/types.ts`)**:
  - Roles: `owner`, `admin`, `manager`, `staff`, `order_staff`, `inventory_staff`, `support_staff`, `customer` enforced server-side via `requirePerm()`.
- **Non-Blocking Optional Integrations (`server.ts`, `worker/index.ts`, `src/server/security.ts`, `src/server/seo.ts`, `src/lib/analytics.ts`)**:
  - `GOOGLE_SITE_VERIFICATION`, `TURNSTILE_SECRET_KEY`, `VITE_TURNSTILE_SITE_KEY`, and `VITE_GA_MEASUREMENT_ID` disable gracefully when unset, whitespace, or placeholder values without breaking builds or faking Turnstile verification.

### Implemented in Source *(Runtime Verification Against Live Cloudflare Pending)*
- **Storefront & Catalog (`src/App.tsx`, `src/components/ProductDetailView.tsx`, `src/server/routes/public.ts`)**: Product search/filtering, variants, specifications, moderated reviews, Q&A, persistent guest/user cart, wishlist, and info pages (`/about`, `/contact`, `/faq`, `/policies`, `/privacy-policy`, `/terms`).
- **Nigerian Checkout & Delivery Zones (`src/components/CheckoutView.tsx`, `src/components/NigerianAddressForm.tsx`, `src/server/routes/orders.ts`)**: State/LGA delivery fee quoting, free-delivery thresholds, coupon validation, idempotent order creation, and manual bank transfer workflow.
- **Order Tracking & Private Receipts (`src/components/TrackOrderView.tsx`, `src/server/routes/orders.ts`)**: Guest lookup verified via email/phone with masked street addresses; bank transfer receipt upload stored under `receipts/` with access restricted to the order owner or `payments:review` staff.
- **Admin Dashboard (`src/components/admin/*`, `src/server/routes/admin.ts`)**: Order management, payment verification/rejection, catalog creation/duplication/archival with DB `UNIQUE` auto-generated `products.sku` and `product_variants.sku`, manual stock adjustments, Point of Sale (`POS`), delivery zones, coupons, Brevo email outbox/history, analytics (confirmed vs unconfirmed revenue), expenses, SEO/theme/bank settings, and staff RBAC.
- **SEO & First-Party Privacy-Safe Analytics (`src/server/seo.ts`, `migrations/0003_seo_analytics.sql`)**: SSR `<meta>`/JSON-LD injection, `/robots.txt`, `/sitemap.xml`, genuine HTTP `404` on unknown routes, and query-stripped first-party analytics events.

### Confirmed Specification Extensions *(Pending Implementation & Migration `0007`)*
All extensions below preserve existing Better Auth workflows, RBAC roles, D1/SQLite `db.batch()` semantics, historical order snapshots, and Brevo outbox delivery:

1. **A. Dual Manual & Automatic SKU Management (`products`, `product_variants`, `order_items`)**:
   - Admins can either enter a custom normalized SKU manually or let SELLORA generate a unique SKU automatically for both parent products and individual product variants.
   - Uniqueness is enforced at the database level (`products.sku UNIQUE`, `product_variants.sku UNIQUE`, plus cross-table/case-insensitive canonical SKU conflict prevention) and handles concurrent creation races (`409` on explicit manual conflict; bounded retry on auto-generation).
   - Full variant management UI & endpoints (`POST /api/admin/products/:id/variants`, `PATCH /api/admin/variants/:id`) allow adding/editing SKUs without overwriting order history.
   - Historical order SKUs (`order_items.sku`) remain immutable snapshots; SKUs already referenced by any `order_items` row cannot be silently changed (`409` rejection on attempted SKU mutation once ordered).
   - Integrates seamlessly across catalog UI, inventory movements/adjustments, checkout, POS, and order displays.
2. **B. Separate Admin Security Password**:
   - Normal admin authentication (Better Auth Email/Password or Google OAuth) remains unchanged as Layer 1 credential verification.
   - After normal authentication succeeds, privileged administrative accounts (`role !== 'customer'`) must verify a **separate admin security password** before accessing the Admin Dashboard UI or `/api/admin/*` operational endpoints.
   - Stored exclusively as a strong salted password hash (`scrypt`, `N=16384, r=8, p=1, dkLen=64`, 16-byte salt — never plaintext), rate-limited with temporary lockout protection on repeated failed attempts, bound to the specific active `session.id` with a defined expiration policy (TTL + invalidation on logout/revocation/lock), and accompanied by safe onboarding setup, authenticated change, and out-of-band/owner recovery flows that preserve all existing admin accounts.
3. **C. Strict Unfamiliar-Device & IP Security Policy**:
   - Policy is **strict fail-closed** for administrative sessions: an unfamiliar device **OR** an unfamiliar IP address triggers a security lock that blocks Admin Dashboard & `/api/admin/*` access while locked.
   - Device recognition uses a cryptographically random, server-issued `HttpOnly; SameSite=Lax` (`Secure` in HTTPS) device token (persisted as SHA-256 digest alongside device metadata and trusted IP records), rather than spoofable User-Agent/fingerprint strings alone.
   - Maintains trusted/recognized device records and `login_history`, logs suspicious attempts (`SEC-XXXXXXXX`), notifies the registered admin inbox, and supports explicit admin approval or rejection of each pending login attempt.
4. **D. Scanner-Safe Gmail Security Approval Workflow**:
   - Whenever an unfamiliar device or IP triggers an admin security lock, SELLORA queues and dispatches an email alert via the existing Brevo outbox (`email_notification_events`) to the registered admin Gmail (`OWNER_EMAIL` / `ADMIN_NOTIFICATION_EMAIL`, currently `olarindevictor046@gmail.com`).
   - Email contains a clear alert summary, request timestamp (UTC & Africa/Lagos), available device/browser & IP/location details, and **`YES — APPROVE ACCESS`** / **`NO — REJECT ACCESS`** action links.
   - Links route to a non-mutating `GET` confirmation page requiring explicit `POST` submission (preventing Gmail/antivirus link-prefetch scanners from auto-approving or auto-rejecting), backed by single-use, short-lived CSPRNG tokens (`20m`, SHA-256 hashed, bound strictly to the exact pending login request ID). Never leaks passwords or reusable credentials in email bodies.
   - **Approve**: unlocks **only** that specific pending login session (admin still must satisfy the separate admin security password gate), registers trusted device/IP per policy, logs `audit_logs` + `security_events`, and sends a confirmation notice.
   - **Reject**: rejects that specific attempt, terminates ONLY the pending session, leaves device untrusted, logs `critical` security event + `audit_logs`, and notifies admin.
   - **No Response / Expiry**: expires **only** that associated login session (`status = 'expired'`, zero auto-approval) without permanently locking the admin account; a fresh login creates a new `session_id` and fresh approval request.
   - **Gmail-Loss Recovery**: includes a documented server-side/offline recovery path (authenticated owner CLI/recovery code mechanism) in case the admin loses Gmail access.
5. **E. Admin Security Management Interface (`AdminSettingsTab.tsx`)**:
   - Extends Owner/Admin Security settings with controls to inspect and manage recognized devices, review recent login attempts, approve/reject/inspect pending security approval requests, revoke individual trusted devices and active sessions, set/change the separate admin security password, and review security events (`SEC-XXXXXXXX`).

### Unfinished Infrastructure / External Verification Items
- **Capacitor Android Wrapper (`capacitor.config.ts`, `docs/ANDROID_CAPACITOR.md`)**: Config exists (`com.sellora.store`), while native `android/` directory and `@capacitor/android` build have not been generated yet.
- **Remote Infrastructure Verification (`UNVERIFIED`)**: GitHub (`olarindevictor1/SELLORA`, `main`), Cloudflare Worker (`sellora-commerce`), D1 (`sellora-db`), R2 (`sellora-media-private`), and live secrets have not been verified from this container.

---

## 4. Related Project Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Runtime topology, database schema, API boundaries, and storage design.
- [`SECURITY_BASELINE.md`](./SECURITY_BASELINE.md) — Implemented security controls, open audit findings, and required mitigations.
- [`PRODUCTION_LAUNCH_CHECKLIST.md`](./PRODUCTION_LAUNCH_CHECKLIST.md) — Mandatory pre-launch verification gates before public deployment.
- [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) — Active bugs, architectural limitations, and verification status.
- [`CHANGELOG.md`](./CHANGELOG.md) — Recorded workspace history and verified milestones.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — Cloudflare Workers/D1/R2 CLI and Git deployment procedures.
- [`ANDROID_CAPACITOR.md`](./ANDROID_CAPACITOR.md) — Native Android build guide via Capacitor.
