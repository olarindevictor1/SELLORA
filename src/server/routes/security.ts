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

  return app;
}
