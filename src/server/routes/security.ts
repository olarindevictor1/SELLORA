import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../context';
import {
  extractSessionTokenFromHeaders,
  checkPersistentRateLimit,
  getTrustedClientIp,
  writeAuditLog,
} from '../security';
import { parseDeviceSummary, processLoginVerificationToken } from '../login-monitor';
import {
  executeAdminApprovalDecision,
  inspectAdminApprovalTokenReadOnly,
} from '../admin-security';
import { formatLagosDate } from '../../shared/types';

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createSecurityRoutes() {
  const app = new Hono<AppContext>();

  // List active sessions & recent login activity for authenticated user (Customer, Staff, or Owner)
  app.get('/me/sessions', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);

    const db = c.get('db');
    const now = new Date().toISOString();
    const currentToken = extractSessionTokenFromHeaders(c.req.raw.headers);

    const rows = await db.all<{
      id: string;
      token: string;
      userAgent: string | null;
      ipAddress: string | null;
      createdAt: string;
      expiresAt: string;
    }>(
      `SELECT id, token, userAgent, ipAddress, createdAt, expiresAt
       FROM session
       WHERE userId = ? AND expiresAt > ?
       ORDER BY createdAt DESC LIMIT 30`,
      [user.id, now]
    );

    const history = await db.all<{
      id: string;
      auth_method: string;
      outcome: string;
      is_new_device: number;
      is_unusual: number;
      device_summary: string;
      approx_location: string | null;
      created_at: string;
    }>(
      `SELECT id, auth_method, outcome, is_new_device, is_unusual, device_summary, approx_location, created_at
       FROM login_history
       WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 15`,
      [user.id]
    );

    return c.json({
      sessions: rows.map((s) => ({
        id: s.id,
        deviceSummary: parseDeviceSummary(s.userAgent).summary,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        isCurrent: Boolean(currentToken && s.token === currentToken),
      })),
      recentLogins: history,
    });
  });

  // Revoke a single active session owned by the signed-in user
  app.delete('/me/sessions/:id', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);

    const db = c.get('db');
    const sessionId = c.req.param('id');
    const res = await db.run(`DELETE FROM session WHERE id = ? AND userId = ?`, [
      sessionId,
      user.id,
    ]);
    if (res.changes === 0) {
      return c.json({ error: 'Session not found' }, 404);
    }

    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'SESSION_SELF_REVOKED',
      targetType: 'session',
      targetId: sessionId,
    });

    return c.json({ ok: true });
  });

  // Sign out all other devices/sessions except the caller's active session
  app.post('/me/sessions/revoke-others', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);

    const currentToken = extractSessionTokenFromHeaders(c.req.raw.headers);
    if (!currentToken) {
      return c.json({ error: 'Current session cookie required to preserve current device.' }, 400);
    }

    const db = c.get('db');
    const res = await db.run(`DELETE FROM session WHERE userId = ? AND token != ?`, [
      user.id,
      currentToken,
    ]);

    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'SESSIONS_REVOKED_OTHERS',
      targetType: 'user',
      targetId: user.id,
      details: { revokedCount: res.changes },
    });

    return c.json({ ok: true, revokedCount: res.changes });
  });

  // Email alert confirmation / dispute landing handler ("This was me" / "This wasn't me")
  app.get('/security/login-response', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `sec_resp:${ip}`, 20, 60_000);
    if (!rl.allowed) {
      return c.html(
        '<h1>Too many requests</h1><p>Please wait a minute and try again.</p>',
        429,
        { 'Cache-Control': 'no-store' }
      );
    }

    const action = c.req.query('action');
    const token = c.req.query('token') || '';
    const expectedAction =
      action === 'confirm' || action === 'dispute' ? action : undefined;

    const result = await processLoginVerificationToken(db, env, token, expectedAction);

    const title = result.ok
      ? result.action === 'confirm'
        ? 'Sign-In Confirmed'
        : 'All Sessions Signed Out'
      : 'Verification Link Invalid';
    const message = result.ok
      ? result.action === 'confirm'
        ? 'Thank you. You confirmed this device sign-in. No further action is needed.'
        : `Security protective action completed (${result.revokedSessions ?? 0} session(s) signed out). Please reset or change your password right away using Forgot Password on SELLORA.`
      : result.error || 'This link could not be verified.';

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SELLORA — ${escapeHtml(title)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F5F7F4;color:#172554;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
    .card{max-width:480px;width:100%;background:#fff;border:1px solid #E2E8F0;border-radius:16px;padding:28px;box-shadow:0 4px 20px rgba(23,37,84,0.06)}
    h1{margin:0 0 10px;font-size:20px}
    p{margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155}
    .ref{font-family:monospace;font-size:12px;color:#64748B;margin-bottom:18px}
    a{display:inline-block;background:#172554;color:#B7F36B;text-decoration:none;font-weight:700;font-size:13px;padding:10px 18px;border-radius:8px}
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${result.eventRef ? `<div class="ref">Security Reference: ${escapeHtml(result.eventRef)}</div>` : ''}
    <a href="/">Return to SELLORA</a>
  </div>
</body>
</html>`;

    return c.html(html, result.ok ? 200 : 400, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    });
  });

  app.post('/security/login-response', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `sec_resp:${ip}`, 20, 60_000);
    if (!rl.allowed) return c.json({ error: 'Too many requests' }, 429);

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      token: z.string().min(32),
      action: z.enum(['confirm', 'dispute']).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid verification token payload' }, 400);

    const result = await processLoginVerificationToken(
      db,
      env,
      parsed.data.token,
      parsed.data.action
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  // Two-step scanner-immune Admin Gmail Approval routes
  // GET: Read-only confirmation form (zero DB mutation so email pre-fetch scanners never approve/reject)
  app.get('/security/admin-approval', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `adm_apv_view:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return c.html(
        '<h1>Too many requests</h1><p>Please wait a minute and try again.</p>',
        429,
        { 'Cache-Control': 'no-store' }
      );
    }

    const actionParam = c.req.query('action');
    const expectedAction =
      actionParam === 'approve' || actionParam === 'reject' ? actionParam : undefined;
    const token = c.req.query('token') || '';

    const inspection = await inspectAdminApprovalTokenReadOnly(db, token, expectedAction);
    const apv = inspection.approval;
    const actionType = inspection.actionType || expectedAction || 'approve';

    const title = !inspection.valid
      ? 'Approval Link Unavailable'
      : actionType === 'approve'
        ? 'Confirm Admin Access Approval'
        : 'Confirm Admin Access Rejection';

    const reasonText =
      apv?.triggerReason === 'unfamiliar_device_and_ip'
        ? 'Unrecognized Device and Unrecognized IP Address'
        : apv?.triggerReason === 'unfamiliar_device'
          ? 'Unrecognized Browser / Device'
          : apv?.triggerReason === 'unfamiliar_ip'
            ? 'Unrecognized IP Address'
            : 'Strict Device/IP Policy';

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SELLORA — ${escapeHtml(title)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F5F7F4;color:#172554;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
    .card{max-width:520px;width:100%;background:#fff;border:1px solid #E2E8F0;border-radius:16px;padding:28px;box-shadow:0 4px 20px rgba(23,37,84,0.06)}
    h1{margin:0 0 10px;font-size:20px}
    p{margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155}
    .meta{background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:12px 14px;margin-bottom:18px;font-size:13px}
    .row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid #EEF2F7}
    .row:last-child{border-bottom:none}
    .lbl{color:#64748B;font-weight:600}
    .val{color:#0F172A;font-weight:600;text-align:right;word-break:break-word}
    .btn{display:inline-block;border:none;cursor:pointer;font-weight:700;font-size:13px;padding:12px 20px;border-radius:8px;text-decoration:none}
    .btn-approve{background:#172554;color:#B7F36B}
    .btn-reject{background:#991B1B;color:#FFFFFF}
    .btn-link{background:#F1F5F9;color:#172554;margin-left:8px}
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    ${
      inspection.valid && apv
        ? `<p>${
            actionType === 'approve'
              ? 'Review the sign-in details below and click confirm to approve ONLY this administrative session. You will still be required to enter your Admin Security Password.'
              : 'Review the sign-in details below and click confirm to reject this request and terminate its session immediately.'
          }</p>
          <div class="meta">
            <div class="row"><span class="lbl">Account</span><span class="val">${escapeHtml(apv.userEmail)}</span></div>
            <div class="row"><span class="lbl">Trigger</span><span class="val">${escapeHtml(reasonText)}</span></div>
            <div class="row"><span class="lbl">Device</span><span class="val">${escapeHtml(apv.deviceSummary)}</span></div>
            <div class="row"><span class="lbl">IP Address</span><span class="val">${escapeHtml(apv.ipAddress)}</span></div>
            <div class="row"><span class="lbl">Approx. Location</span><span class="val">${escapeHtml(apv.approxLocation)}</span></div>
            <div class="row"><span class="lbl">Requested (WAT)</span><span class="val">${escapeHtml(formatLagosDate(apv.createdAt))}</span></div>
            <div class="row"><span class="lbl">Expires (UTC)</span><span class="val">${escapeHtml(apv.expiresAt)}</span></div>
          </div>
          <form method="POST" action="/api/security/admin-approval">
            <input type="hidden" name="token" value="${escapeHtml(token)}">
            <input type="hidden" name="action" value="${escapeHtml(actionType)}">
            <button type="submit" class="btn ${actionType === 'approve' ? 'btn-approve' : 'btn-reject'}">${
              actionType === 'approve' ? 'YES — APPROVE ACCESS' : 'NO — REJECT ACCESS'
            }</button>
            <a class="btn btn-link" href="/">Cancel</a>
          </form>`
        : `<p>${escapeHtml(inspection.error || 'This approval request is no longer valid.')}</p>
           <a class="btn btn-approve" href="/">Return to SELLORA</a>`
    }
  </div>
</body>
</html>`;

    return c.html(html, inspection.valid ? 200 : 400, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    });
  });

  // POST: Explicit human-triggered execution for Gmail approval / rejection
  app.post('/security/admin-approval', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `adm_apv_exec:${ip}`, 20, 60_000);
    if (!rl.allowed) return c.json({ error: 'Too many requests' }, 429);

    const contentType = (c.req.header('content-type') || '').toLowerCase();
    const isFormSubmit =
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data');

    let rawToken = '';
    let rawAction = '';
    if (isFormSubmit) {
      const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
      rawToken = typeof form.token === 'string' ? form.token : '';
      rawAction = typeof form.action === 'string' ? form.action : '';
    } else {
      const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
      rawToken = typeof body.token === 'string' ? body.token : '';
      rawAction = typeof body.action === 'string' ? body.action : '';
    }

    if (rawAction !== 'approve' && rawAction !== 'reject') {
      if (isFormSubmit) {
        return c.html('<h1>Invalid Decision</h1><p>Action must be approve or reject.</p>', 400, {
          'Cache-Control': 'no-store',
        });
      }
      return c.json({ error: 'Action must be approve or reject.' }, 400);
    }

    const result = await executeAdminApprovalDecision(db, env, {
      rawToken,
      action: rawAction,
      actorLabel: 'gmail_email_action',
    });

    if (isFormSubmit || (c.req.header('accept') || '').includes('text/html')) {
      const title = result.ok
        ? result.decision === 'approved'
          ? 'Admin Access Approved'
          : 'Admin Access Rejected'
        : 'Verification Could Not Be Completed';
      const msg = result.ok
        ? result.decision === 'approved'
          ? 'This sign-in session has been approved and its device/IP added to your recognized list. Return to SELLORA and enter your Admin Security Password to unlock the dashboard.'
          : 'The pending sign-in request was rejected and its login session was terminated immediately.'
        : result.error || 'Unable to process this approval request.';
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SELLORA — ${escapeHtml(title)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F5F7F4;color:#172554;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
    .card{max-width:480px;width:100%;background:#fff;border:1px solid #E2E8F0;border-radius:16px;padding:28px;box-shadow:0 4px 20px rgba(23,37,84,0.06)}
    h1{margin:0 0 10px;font-size:20px}
    p{margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155}
    .ref{font-family:monospace;font-size:12px;color:#64748B;margin-bottom:18px}
    a{display:inline-block;background:#172554;color:#B7F36B;text-decoration:none;font-weight:700;font-size:13px;padding:10px 18px;border-radius:8px}
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(msg)}</p>
    ${result.eventRef ? `<div class="ref">Security Reference: ${escapeHtml(result.eventRef)}</div>` : ''}
    <a href="/?view=admin">Continue to SELLORA</a>
  </div>
</body>
</html>`;
      return c.html(html, result.status as 200, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      });
    }

    return c.json(result, result.status as 200);
  });

  return app;
}
