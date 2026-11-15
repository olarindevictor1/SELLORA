# SELLORA — Cloudflare Deployment, Backup & Operations Guide

## 1. Free-Tier Architecture Notes
- **Cloudflare Workers & Static Assets**: Hosts the frontend (`dist/`) and API (`worker/index.ts`).
- **Cloudflare D1**: Relational SQLite database (`sellora-db`) using integer NGN kobo pricing and `migrations/0001_initial.sql`.
- **Cloudflare R2**: Private storage for payment receipts (`receipts/`) and product media (`products/`). Note: R2 requires a Cloudflare account with R2 enabled (free tier includes 10 GB-month storage; verify current Cloudflare free-tier limits before enabling).
- **Brevo Transactional Email**: Free tier provides 300 emails/day via `POST https://api.brevo.com/v3/smtp/email`.
- **Cloudflare Turnstile**: Free bot protection for checkout/auth forms.

## 2. Environment Secrets & Optional Build Vars
Never place secrets in `VITE_*` variables. Set server secrets using Wrangler secrets (Cloudflare Workers uses the `DB` D1 binding in `wrangler.toml`, so `SQLITE_DB_PATH` is never required in production):
```bash
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put OWNER_EMAIL
wrangler secret put ADMIN_NOTIFICATION_EMAIL
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put BREVO_API_KEY
wrangler secret put BREVO_FROM_EMAIL
wrangler secret put TURNSTILE_SECRET_KEY
```

Optional build/public configuration:
- `VITE_TURNSTILE_SITE_KEY`: Public Turnstile widget site key (required only when `TURNSTILE_SECRET_KEY` is active).
- `VITE_GA_MEASUREMENT_ID`: Optional GA4 measurement ID (fallback if not saved in Admin → Settings).
- `GOOGLE_SITE_VERIFICATION`: Optional Search Console HTML meta token (can also be saved in Admin → Settings → SEO).

## 3. Google OAuth Branding, Search Console & Cloudflare Turnstile
- **Better Auth Base Path**: `/api/auth`
- **Google Authorized JavaScript Origin**: `<APP_URL>`
- **Google OAuth Callback URI**: `<APP_URL>/api/auth/callback/google`
- **Google Auth Platform Branding URLs**:
  - Homepage: `<APP_URL>/`
  - Privacy Policy: `<APP_URL>/privacy-policy`
  - Terms of Service: `<APP_URL>/terms`
- **Turnstile Hostnames**: Register the exact deployment domain(s) (e.g., `your-sellora-domain.workers.dev` and any custom domain, plus `localhost` for local testing) in the Cloudflare Turnstile dashboard under the widget paired with `VITE_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`.

## 4. D1 Database Migrations (Non-Destructive)
The D1 database (`sellora-db`, ID `a6738474-f10d-4210-b8fe-194fab0e3bd8`) is pre-bound in `wrangler.toml`:
```bash
# Apply migrations locally for Wrangler dev
npm run cf:migrate:local

# Apply migrations to production D1 (additive, preserves all existing records)
npm run cf:migrate:remote
```

## 5. Build & Deploy to Cloudflare Workers (`sellora-commerce`)
```bash
npm install
npm run build
npx wrangler deploy
```
Or connect GitHub (`olarindevictor1/SELLORA`, branch `main`) directly inside **Cloudflare Dashboard → Workers & Pages → Create → Import a repository**:
- **Build command**: `npm run build`
- **Deploy command**: `npx wrangler deploy`
- **Root directory**: `/`

> Note: Cloudflare Dashboard's drag-and-drop ZIP uploader only deploys static files (`dist/`) and does not execute `worker/index.ts`, D1, or R2 bindings. Use either **Cloudflare Workers Git Integration** (`olarindevictor1/SELLORA`) or **Wrangler CLI** (`npm run cf:deploy`) to launch the full-stack SELLORA platform.

## 6. Store Owner Authentication & Provisioning (No Manual Bootstrap Secret)
The authorized owner (`OWNER_EMAIL`, default `olarindevictor3@gmail.com`) signs in through the standard **Sign In** dialog using either **Continue with Google** or **Email & Password** — both resolve to the same `user` account when `trustedProviders: ['google']` is enabled:
1. **Google OAuth Sign-In**: When Google returns a verified identity (`emailVerified = true`) matching `OWNER_EMAIL`, Better Auth automatically authorizes and links the `owner` account on the server.
2. **Email & Password Provisioning (Server CLI Only)**: To pre-provision an initial owner password before first login without exposing any claim secret in the UI:
   - Local SQLite: `npm run owner:provision -- --email olarindevictor3@gmail.com`
   - Production Cloudflare D1: generate safe idempotent SQL with `npm run owner:provision -- --d1-sql > owner.sql` and execute `npx wrangler d1 execute sellora-db --remote --file=owner.sql` (then delete `owner.sql`).
3. **Password Reset**: If the owner first signed in via Google and wants to add or reset a password, use **Forgot password?** on the Sign-In modal; Better Auth sends a signed reset token via Brevo.
4. **Security Guardrails**: Public email/password self-registration for `OWNER_EMAIL` is blocked (`403`). Customer registrations default strictly to `role = 'customer'` and never elevate on email/password signup.

## 7. Manual Free-Tier Backup & Recovery
Under free-tier D1 configuration without automated paid snapshots:
1. Export database snapshot before any schema migration:
   ```bash
   wrangler d1 export sellora-db --remote --output=./backups/sellora-$(date +%F).sql
   ```
2. For local SQLite (`SQLITE_DB_PATH` — dev only):
   ```bash
   sqlite3 .data/sellora.db ".backup './backups/sellora-local.db'"
   ```
3. To restore from a SQL backup:
   ```bash
   wrangler d1 execute sellora-db --remote --file=./backups/sellora-YYYY-MM-DD.sql
   ```

## 8. Rollback Procedure
1. List previous Worker deployments: `wrangler deployments list`
2. Roll back Worker code: `wrangler rollback <DEPLOYMENT_ID>`
3. Restore D1 export if a migration must be reverted.

## 9. GitHub Synchronization (`olarindevictor1/SELLORA`, branch `main`)
```bash
git init -b main
git remote add origin https://github.com/olarindevictor1/SELLORA.git
git fetch origin main
git add .
git status   # verify no .env, .data/, node_modules/, or .zip files are staged
git commit -m "Prepare SELLORA for Cloudflare Workers, D1, and R2 deployment"
git push -u origin main
```

