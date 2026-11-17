# SELLORA — Project Overview

**Tagline:** Commerce without limits.  
**Last Verified Against Source:** 2026-11-15  
**Current Project Status:** `IN PROGRESS / INCOMPLETE` (Local codebase operational; Stage 2 D1 atomicity & pre-launch security hardening pending approval; production deployment not yet verified)

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
  - Roles: `owner`, `admin`, `staff`, `customer` enforced server-side via `requirePerm()`.
- **Non-Blocking Optional Integrations (`server.ts`, `worker/index.ts`, `src/server/security.ts`, `src/server/seo.ts`, `src/lib/analytics.ts`)**:
  - `GOOGLE_SITE_VERIFICATION`, `TURNSTILE_SECRET_KEY`, `VITE_TURNSTILE_SITE_KEY`, and `VITE_GA_MEASUREMENT_ID` disable gracefully when unset, whitespace, or placeholder values without breaking builds or faking Turnstile verification.

### Implemented in Source *(Runtime Verification Against Live Cloudflare Pending)*
- **Storefront & Catalog (`src/App.tsx`, `src/components/ProductDetailView.tsx`, `src/server/routes/public.ts`)**: Product search/filtering, variants, specifications, moderated reviews, Q&A, persistent guest/user cart, wishlist, and info pages (`/about`, `/contact`, `/faq`, `/policies`, `/privacy-policy`, `/terms`).
- **Nigerian Checkout & Delivery Zones (`src/components/CheckoutView.tsx`, `src/components/NigerianAddressForm.tsx`, `src/server/routes/orders.ts`)**: State/LGA delivery fee quoting, free-delivery thresholds, coupon validation, idempotent order creation, and manual bank transfer workflow.
- **Order Tracking & Private Receipts (`src/components/TrackOrderView.tsx`, `src/server/routes/orders.ts`)**: Guest lookup verified via email/phone with masked street addresses; bank transfer receipt upload stored under `receipts/` with access restricted to the order owner or `payments:review` staff.
- **Admin Dashboard (`src/components/admin/*`, `src/server/routes/admin.ts`)**: Order management, payment verification/rejection, catalog/variant CRUD, manual stock adjustments, Point of Sale (`POS`), delivery zones, coupons, Brevo email outbox/history, analytics (confirmed vs unconfirmed revenue), expenses, SEO/theme/bank settings, and staff RBAC.
- **SEO & First-Party Privacy-Safe Analytics (`src/server/seo.ts`, `migrations/0003_seo_analytics.sql`)**: SSR `<meta>`/JSON-LD injection, `/robots.txt`, `/sitemap.xml`, genuine HTTP `404` on unknown routes, and query-stripped first-party analytics events.

### Partially Implemented / Unfinished
- **Cloudflare D1 Atomic Transactions & Concurrency Guards** *(Identified High Risk — Stage 2 Fix Pending Approval)*: `createD1Db.transaction()` (`src/server/db.ts`) is currently non-atomic (`fn(self)`), and checkout deducts stock before validating delivery zone/coupons and increments coupon `used_count` without an atomic limit guard.
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
