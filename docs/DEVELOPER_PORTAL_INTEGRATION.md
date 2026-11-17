# SELLORA — Developer Portal Integration Guide (Layer 3)

This document describes how an authorized external engineering or support portal (such as a client-approved PixelBridge developer portal) connects to SELLORA cleanly and safely without accessing customer orders, banking details, or store management credentials.

---

## 1. Security Boundary & Authorization Model

- **Client-Authorized Only**: External developer access is disabled by default. Only the authenticated store owner (`role === 'owner'`, recent sign-in `<= 30 minutes`) can generate or revoke an integration key inside **Admin → Settings → Store Details → Security & Support Access**.
- **Strict Separation from Store Accounts**:
  - `/api/developer/*` accepts **only** `Authorization: Bearer slr_dev_...` tokens validated against SHA-256 hashes in `developer_integrations`.
  - Storefront/admin Better Auth session cookies are strictly rejected (`401`) on `/api/developer/*`.
  - Developer Bearer keys are invalid everywhere outside `/api/developer/*` (they cannot access `/api/admin/*`, `/api/orders/*`, `/api/payments/*`, `/api/me/*`, or customer PII).
- **Least-Privilege Scopes**:
  - `errors:read` — Query and inspect sanitized error diagnostic records (`ERR-XXXXXXXX`).
  - `errors:update` — Update `investigationStatus` (`open`, `investigating`, `resolved`, `ignored`) and `resolutionNotes`.
  - `security:read` — Read `security_events` (`SEC-XXXXXXXX`) metadata (risk level, category, approximate country/city, device summary, status).
  - `security:update` — Update `security_events` mitigation/resolution notes and status (`recorded`, `mitigated`, `resolved`).
  - `audit:read` — Read redacted `audit_logs` records (sensitive keys stripped via `sanitizeDiagnosticObject`).
- **Expiration & Revocation**: Keys support configurable expiration (e.g., 90 days) and can be immediately revoked by the owner (`DELETE /api/admin/developer-integrations/:id`), returning HTTP `403` on any subsequent call.

---

## 2. API Endpoints

Base path: `<APP_URL>/api/developer`  
Required header: `Authorization: Bearer slr_dev_<48 hex chars>`

| Method & Path | Required Scope | Purpose |
| :--- | :--- | :--- |
| `GET /errors` | `errors:read` | List latest 100 sanitized `error_monitoring_logs` (`?status=&category=&refId=`). |
| `GET /errors/:refId` | `errors:read` | Fetch single diagnostic record by reference ID (e.g. `ERR-7K9M2Q4P`). |
| `PATCH /errors/:refId` | `errors:update` | Set `{ investigationStatus, resolutionNotes }` and log `DEVELOPER_ERROR_STATUS_UPDATED`. |
| `GET /security-events` | `security:read` | List latest 100 sanitized security events (`?status=`). |
| `PATCH /security-events/:eventRef` | `security:update` | Set `{ status: "recorded" | "mitigated" | "resolved", resolutionNotes }`. |
| `GET /audit-logs` | `audit:read` | List latest 100 immutable audit events with sensitive fields redacted. |

All `/api/developer/*` responses enforce `Cache-Control: no-store` and IP rate limiting (`60 requests/min` via `security_rate_limits`).

---

## 3. Data Redaction Guarantees

Before any error or diagnostic detail enters `error_monitoring_logs` or `/api/developer/audit-logs`, `redactSensitiveText()` and `sanitizeDiagnosticObject()` strip:
- `Authorization: Bearer ...` headers and `slr_dev_...` tokens
- Brevo keys (`xkeysib-...`), Google API/OAuth secrets (`AIza...`, `GOCSPX-...`), cookies, and password/secret keys
- Database connection strings (`sqlite://`, `postgres://`, `d1://`) and local absolute workspace paths
