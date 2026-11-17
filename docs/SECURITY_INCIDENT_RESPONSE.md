# SELLORA — Security Incident Response Runbook

**Owner Login Email:** `OWNER_EMAIL` (`olarindevictor046@gmail.com`)  
**Alert Notification Inbox:** `ADMIN_NOTIFICATION_EMAIL` (`olarindevictor046@gmail.com` by default unless updated in Admin Email Settings)  
**Log Tables:** `error_monitoring_logs` (`ERR-XXXXXXXX`), `security_events` (`SEC-XXXXXXXX`), `login_history`, `audit_logs` (immutable)

---

## 1. Triage by Reference ID

Customers or store staff report issues using a safe opaque ID such as `ERR-XXXXXXXX` or `SEC-XXXXXXXX`:
1. **Error Reference (`ERR-XXXXXXXX`)**:
   - Query `GET /api/developer/errors/<ERR-REF>` using an owner-authorized support key (or inspect `error_monitoring_logs` in D1).
   - Inspect `service_category`, `failed_operation`, `location`, `sanitized_message`, `occurrence_count`, and `retry_history_json`.
   - Update `investigationStatus` (`investigating` -> `resolved`) with `resolutionNotes` once mitigated.
2. **Security Event (`SEC-XXXXXXXX`)**:
   - Inspect in **Owner → Settings → Store Details → Security & Support Access** or via `GET /api/developer/security-events`.

---

## 2. Compromised Account or Unrecognized Device Sign-In

1. **Automated / User Self-Service Action**:
   - If the user clicks **"This wasn't me"** in their email alert (`/api/security/login-response?action=dispute&token=...`), SELLORA immediately deletes **all** active `session` rows for that account, removes trust on that device, upgrades the `security_events` severity to `critical`, invalidates the paired confirmation link, and emails the store owner.
   - Any signed-in customer or owner can also click **"Sign Out Other Devices"** in Account Profile or Admin Settings (`POST /api/me/sessions/revoke-others`).
2. **Owner/Staff Remediation Steps**:
   - Reset the account password (do not reuse prior passwords).
   - Verify no unauthorized staff accounts or `developer_integrations` keys were created (`GET /api/admin/staff`, `GET /api/admin/developer-integrations`).
   - Review recent bank-transfer verification actions and `audit_logs` around the incident timestamp.

---

## 3. Brute-Force or Abuse Surge

- `auth_login_throttles` automatically enforces progressive account lockouts across failed password logins: 1st failure records only; 2nd consecutive failure locks for **10 minutes (`600s`)**; subsequent failures after lockout expires add **+5 minutes (`+300s`) per cycle** (`15m -> 20m -> 25m -> ...`) up to configurable `LOGIN_MAX_LOCKOUT_SECONDS` (default `3600s` = 60 minutes). Counters reset only on valid login or verified password reset (`account_lockout_triggered` / `ip_brute_force_throttled` logged with `SEC-XXXXXXXX`).
- If sustained DDoS/bot traffic persists:
  1. Confirm Cloudflare Turnstile keys (`TURNSTILE_SECRET_KEY`, `VITE_TURNSTILE_SITE_KEY`) are active.
  2. Tighten Cloudflare Dashboard WAF / Rate Limiting rules on `/api/auth/*`, `/api/checkout`, and `/api/payments/*`.

---

## 4. Suspected Secret or Developer Key Exposure

- **Exposed `slr_dev_...` Key**: Immediately revoke in **Admin → Settings → Security & Support Access** (`DELETE /api/admin/developer-integrations/:id`) — access is blocked (`403`) immediately.
- **Exposed Infrastructure Secret** (`BETTER_AUTH_SECRET`, `BREVO_API_KEY`, `BREVO_WEBHOOK_SECRET`, `GOOGLE_CLIENT_SECRET`): Rotate via `wrangler secret put` and revoke active sessions if session signing material was impacted.
