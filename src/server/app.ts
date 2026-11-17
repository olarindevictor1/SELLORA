import { Hono } from 'hono';
import { z } from 'zod';
import { timingSafeEqualStr } from './crypto';
import type { AppContext, AppEnvConfig } from './context';
import type { SelloraDb, SelloraStorage } from './db';
import { createSelloraAuth, getSessionUser } from './auth';
import { respondWithCapturedError } from './error-monitor';
import { recordLoginAttemptAndMonitor } from './login-monitor';
import {
  dispatchSingleEmailEvent,
  queueEmailEvent,
  renderSelloraEmailHtml,
} from './email';
import {
  checkLoginThrottle,
  checkPersistentRateLimit,
  clearLoginThrottle,
  getTrustedClientIp,
  isTurnstileConfigured,
  recordFailedLoginAttempt,
  recordSecurityEvent,
  requireRecentAuthSession,
  verifyTurnstileToken,
  withSignInEmailLock,
  writeAuditLog,
} from './security';
import {
  buildAdminDeviceCookieHeader,
  evaluateAdminLoginGate,
} from './admin-security';
import { createPublicRoutes } from './routes/public';
import { createCustomerRoutes } from './routes/customer';
import { createOrderRoutes } from './routes/orders';
import { createAdminRoutes } from './routes/admin';
import { createSecurityRoutes } from './routes/security';
import { createDeveloperRoutes } from './routes/developer';

const TURNSTILE_PROTECTED_AUTH_PATHS = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-up/email',
  '/api/auth/request-password-reset',
  '/api/auth/forget-password',
]);

function buildAllowedOrigins(reqUrl: string, headers: Headers, env: AppEnvConfig): Set<string> {
  const allowed = new Set<string>([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost',
    'https://localhost',
  ]);
  for (const extra of env.corsAllowedOrigins || []) {
    try {
      allowed.add(new URL(extra).origin);
    } catch {
      // ignore malformed origin
    }
  }
  if (env.appUrl) {
    try {
      allowed.add(new URL(env.appUrl).origin);
    } catch {
      // ignore malformed env appUrl
    }
  }
  try {
    allowed.add(new URL(reqUrl).origin);
  } catch {
    // ignore
  }
  const host = headers.get('x-forwarded-host') || headers.get('host');
  if (host) {
    allowed.add(`https://${host}`);
    allowed.add(`http://${host}`);
  }
  return allowed;
}

function extractIssuedSessionToken(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/(?:__Secure-)?sellora\.session_token=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).split('.')[0] || null;
  } catch {
    return null;
  }
}

export function createSelloraApiApp(deps: {
  db: SelloraDb;
  storage: SelloraStorage;
  auth: ReturnType<typeof createSelloraAuth>;
  env: AppEnvConfig;
}) {
  const app = new Hono<AppContext>();

  // Global private error capture handler — zero stack traces or internal secrets leaked to callers
  app.onError(async (err, c) => {
    return respondWithCapturedError(c, {
      status: 500,
      publicMessage: 'An unexpected issue occurred while processing your request. Please try again.',
      serviceCategory: c.req.path.startsWith('/api/auth/')
        ? 'auth'
        : c.req.path.startsWith('/api/checkout') || c.req.path.startsWith('/api/payments')
          ? 'checkout'
          : 'api',
      failedOperation: `${c.req.method} ${c.req.path}`,
      location: c.req.path,
      error: err,
    });
  });

  app.notFound((c) => c.json({ error: 'Endpoint not found.' }, 404));

  // Security headers, strict CORS allowlist, CSRF origin check, & dependency injection
  app.use('*', async (c, next) => {
    c.set('db', deps.db);
    c.set('storage', deps.storage);
    c.set('auth', deps.auth);
    c.set('env', deps.env);

    const path = c.req.path;
    const method = c.req.method.toUpperCase();
    const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const isNonCookieEndpoint =
      path.startsWith('/api/webhooks/') || path.startsWith('/api/developer');

    const allowedOrigins = buildAllowedOrigins(c.req.url, c.req.raw.headers, deps.env);
    const origin = c.req.header('origin');
    const secFetchSite = (c.req.header('sec-fetch-site') || '').toLowerCase();

    if (origin && allowedOrigins.has(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      c.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-cart-token, x-turnstile-token, x-brevo-secret'
      );
    }

    if (method === 'OPTIONS') {
      if (origin && !allowedOrigins.has(origin)) {
        return c.json({ error: 'Cross-origin request rejected.' }, 403);
      }
      return c.body(null, 204);
    }

    // CSRF Origin & Fetch-Metadata enforcement on cookie-backed state changes
    if (isMutating && !isNonCookieEndpoint) {
      const isTrustedAppOrigin = Boolean(
        origin &&
          (origin === 'capacitor://localhost' ||
            origin === 'ionic://localhost' ||
            origin === 'http://localhost' ||
            origin === 'https://localhost' ||
            (deps.env.corsAllowedOrigins || []).includes(origin))
      );
      if (secFetchSite === 'cross-site' && !isTrustedAppOrigin) {
        return c.json({ error: 'Cross-site state mutation blocked.' }, 403);
      }
      if (origin && !allowedOrigins.has(origin)) {
        return c.json({ error: 'Origin mismatch blocked for security.' }, 403);
      }
      if (!origin) {
        const referer = c.req.header('referer');
        if (referer) {
          try {
            const refOrigin = new URL(referer).origin;
            if (!allowedOrigins.has(refOrigin)) {
              return c.json({ error: 'Cross-origin referer blocked for security.' }, 403);
            }
          } catch {
            return c.json({ error: 'Invalid referer header.' }, 403);
          }
        }
      }
    }

    // Resolve Better Auth session user on standard store API routes (never on /api/developer Bearer API)
    if (!path.startsWith('/api/auth/') && !path.startsWith('/api/developer')) {
      const user = await getSessionUser(deps.auth, deps.db, c.req.raw.headers);
      c.set('user', user);
    } else {
      c.set('user', null);
    }

    await next();

    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const isHttps =
      c.req.url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https';
    if (isHttps) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    const isHtmlOrSandboxedFile =
      path === '/api/auth/complete' ||
      path === '/api/security/login-response' ||
      path === '/api/security/admin-approval' ||
      /^\/api\/payments\/evidence\/[^/]+\/file$/.test(path);
    if (!isHtmlOrSandboxedFile) {
      c.header('X-Frame-Options', 'DENY');
      if (!c.res.headers.has('Content-Security-Policy')) {
        c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      }
    }

    if (
      path.startsWith('/api/auth/') ||
      path.startsWith('/api/admin/') ||
      path.startsWith('/api/me/') ||
      path.startsWith('/api/developer')
    ) {
      c.header('Cache-Control', 'no-store');
    }
  });

  // Safe OAuth completion page for popup flows inside cross-origin preview iframes
  app.get('/api/auth/complete', (c) => {
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>SELLORA — Authentication Complete</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#F5F7F4;color:#172554;">
  <p>Completing sign-in...</p>
  <script>
    (function () {
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: 'SELLORA_OAUTH_COMPLETE' }, window.location.origin);
          window.close();
          return;
        }
      } catch (e) {}
      window.location.replace('/');
    })();
  </script>
</body>
</html>`;
    return c.html(html, 200, { 'Cache-Control': 'no-store' });
  });

  // Hardened Authentication Wrapper: Reserved Owner Protection, Brute-Force Lockout, Turnstile & Login Monitoring
  app.all('/api/auth/*', async (c) => {
    const ip = getTrustedClientIp(c.req.raw.headers, deps.env);
    const method = c.req.method.toUpperCase();
    const path = c.req.path;

    // Rate limit authentication endpoints using shared persistent buckets
    if (method === 'POST') {
      const authRl = await checkPersistentRateLimit(deps.db, `auth:${path}:${ip}`, 30, 60_000);
      if (!authRl.allowed) {
        return c.json(
          { error: 'Too many authentication attempts. Please wait a moment and retry.' },
          429,
          { 'Retry-After': String(authRl.retryAfterSec) }
        );
      }
    }

    let parsedBody: Record<string, unknown> = {};
    if (method === 'POST') {
      try {
        parsedBody = (await c.req.raw.clone().json()) as Record<string, unknown>;
      } catch {
        parsedBody = {};
      }
    }
    const emailInput =
      typeof parsedBody.email === 'string' ? parsedBody.email.trim().toLowerCase() : '';

    if (method === 'POST' && path === '/api/auth/sign-up/email') {
      const ownerEmail = deps.env.ownerEmail?.trim().toLowerCase();
      if (ownerEmail && emailInput === ownerEmail) {
        await recordSecurityEvent(deps.db, {
          email: emailInput,
          eventCategory: 'reserved_owner_signup_blocked',
          severity: 'high',
          riskLevel: 'high',
          ipAddress: ip,
          userAgent: c.req.header('user-agent') || null,
        });
        return c.json(
          {
            error:
              'This email is reserved for the store owner. Sign in with your owner password or verified Google account.',
          },
          403
        );
      }
    }

    // Protect /api/auth/change-email from reserved-email hijacking and enforce owner step-up + uniqueness
    let changeEmailActor: Awaited<ReturnType<typeof getSessionUser>> = null;
    if (method === 'POST' && path === '/api/auth/change-email') {
      changeEmailActor = await getSessionUser(deps.auth, deps.db, c.req.raw.headers);
      if (!changeEmailActor) {
        return c.json({ error: 'Authentication required.' }, 401);
      }
      const newEmail =
        typeof parsedBody.newEmail === 'string' ? parsedBody.newEmail.trim().toLowerCase() : '';
      const ownerEmail = deps.env.ownerEmail?.trim().toLowerCase();
      if (changeEmailActor.role !== 'owner' && ownerEmail && newEmail === ownerEmail) {
        await recordSecurityEvent(deps.db, {
          userId: changeEmailActor.id,
          email: changeEmailActor.email,
          eventCategory: 'reserved_owner_email_change_blocked',
          severity: 'high',
          riskLevel: 'high',
          ipAddress: ip,
          userAgent: c.req.header('user-agent') || null,
          metadata: { attemptedNewEmail: newEmail },
        });
        return c.json({ error: 'This email address is reserved and cannot be assigned.' }, 403);
      }
      if (changeEmailActor.role === 'owner') {
        const recent = await requireRecentAuthSession(deps.db, c.req.raw.headers);
        if (!recent) {
          return c.json(
            { error: 'Please sign in again before changing the administrator login email.' },
            403
          );
        }
        if (newEmail) {
          const conflict = await deps.db.get<{ id: string }>(
            `SELECT id FROM user WHERE LOWER(email) = ? AND id != ?`,
            [newEmail, changeEmailActor.id]
          );
          if (conflict) {
            return c.json({ error: 'An account with that email address already exists.' }, 409);
          }
        }
      }
    }

    if (
      method === 'POST' &&
      TURNSTILE_PROTECTED_AUTH_PATHS.has(path) &&
      isTurnstileConfigured(deps.env)
    ) {
      const token =
        c.req.header('x-turnstile-token') ||
        (typeof parsedBody.turnstileToken === 'string' ? parsedBody.turnstileToken : undefined);
      const check = await verifyTurnstileToken({
        token,
        secretKey: deps.env.turnstileSecretKey,
        siteKey: deps.env.turnstileSiteKey,
        remoteIp: ip,
        db: deps.db,
      });
      if (!check.ok) {
        return c.json({ error: check.error || 'Bot verification failed.' }, 400);
      }
    }

    // Serialized password sign-in path enforcing: Attempt 1 -> 401; Attempt 2 -> 10m lock (429); Attempt 3+ -> +5m/cycle capped
    if (method === 'POST' && path === '/api/auth/sign-in/email' && emailInput) {
      return withSignInEmailLock(emailInput, async () => {
        const throttle = await checkLoginThrottle(deps.db, emailInput, ip);
        if (throttle.unavailable) {
          return respondWithCapturedError(c, {
            status: 503,
            publicMessage:
              'Sign-in is temporarily unavailable while security checks are offline. Please try again shortly.',
            serviceCategory: 'security',
            failedOperation: 'login_throttle_check',
            location: '/api/auth/sign-in/email',
            error: throttle.error ?? new Error('Login throttle check unavailable'),
          });
        }
        if (!throttle.allowed) {
          await recordLoginAttemptAndMonitor(deps.db, deps.env, {
            headers: c.req.raw.headers,
            email: emailInput,
            authMethod: 'email_password',
            outcome: 'locked',
          });
          return c.json(
            {
              error:
                throttle.reason ||
                'Sign-in is temporarily restricted due to repeated attempts. Please wait before trying again or reset your password.',
            },
            429,
            { 'Retry-After': String(throttle.retryAfterSec) }
          );
        }

        const authRes = await deps.auth.handler(c.req.raw);
        if (!authRes.ok) {
          const failInfo = await recordFailedLoginAttempt(deps.db, emailInput, ip, {
            maxLockoutSec: deps.env.loginMaxLockoutSeconds,
          });
          if (failInfo.unavailable) {
            return respondWithCapturedError(c, {
              status: 503,
              publicMessage:
                'Sign-in is temporarily unavailable while security checks are offline. Please try again shortly.',
              serviceCategory: 'security',
              failedOperation: 'login_throttle_record_failure',
              location: '/api/auth/sign-in/email',
              error: failInfo.error ?? new Error('Failed login attempt persistence unavailable'),
            });
          }
          const userRow = await deps.db.get<{
            id: string;
            name: string;
            email: string;
            role: string;
          }>(`SELECT id, name, email, role FROM user WHERE LOWER(email) = ?`, [emailInput]);

          await recordLoginAttemptAndMonitor(deps.db, deps.env, {
            headers: c.req.raw.headers,
            userId: userRow?.id ?? null,
            email: emailInput,
            authMethod: 'email_password',
            outcome: failInfo.locked ? 'locked' : 'failed',
          });

          if (failInfo.locked) {
            if (failInfo.newlyLocked && userRow) {
              try {
                const html = renderSelloraEmailHtml({
                  title: 'Security Notice: Repeated Failed Sign-In Attempts',
                  greeting: `Hello ${userRow.name || 'SELLORA User'},`,
                  intro:
                    'Repeated incorrect password attempts were detected on your SELLORA account. Sign-in via email and password has been temporarily paused to protect your account.',
                  detailsRows: [
                    { label: 'Temporary Cooldown', value: `${Math.ceil(failInfo.retryAfterSec / 60)} minutes` },
                    { label: 'Client IP', value: ip },
                  ],
                  footerNote:
                    'If this was you, wait for the cooldown to expire or use password recovery. If not, reset your password promptly.',
                });
                const queued = await queueEmailEvent(deps.db, {
                  idempotencyKey: `lockout_alert:${userRow.id}:${failInfo.lockoutCycles}`,
                  recipientEmail: userRow.email,
                  recipientType: userRow.role === 'owner' || userRow.role === 'admin' ? 'admin' : 'customer',
                  notificationType: 'security_login_lockout',
                  subject: '[SELLORA Security] Temporary Sign-In Lockout Triggered',
                  htmlBody: html,
                });
                if (queued.queued && queued.eventId) {
                  await dispatchSingleEmailEvent(deps.db, deps.env, queued.eventId).catch(() => {});
                }
              } catch {
                // Email notification must not break lockout enforcement
              }
            }
            return c.json(
              {
                error:
                  'Sign-in is temporarily restricted due to repeated attempts. Please wait before trying again or reset your password.',
              },
              429,
              { 'Retry-After': String(failInfo.retryAfterSec) }
            );
          }

          return c.json({ error: 'Invalid email or password.' }, 401);
        }

        await clearLoginThrottle(deps.db, emailInput, ip);
        const userRow = await deps.db.get<{
          id: string;
          name: string;
          email: string;
          role: string;
        }>(`SELECT id, name, email, role FROM user WHERE LOWER(email) = ?`, [emailInput]);
        if (userRow) {
          const issuedToken = extractIssuedSessionToken(authRes.headers.get('set-cookie'));
          const sessRow = issuedToken
            ? await deps.db.get<{ id: string }>(`SELECT id FROM session WHERE token = ?`, [issuedToken])
            : null;
          const loginMonitor = await recordLoginAttemptAndMonitor(deps.db, deps.env, {
            headers: c.req.raw.headers,
            userId: userRow.id,
            email: userRow.email,
            userName: userRow.name,
            userRole: userRow.role,
            authMethod: 'email_password',
            outcome: 'success',
            sessionId: sessRow?.id ?? null,
          });
          if (userRow.role !== 'customer' && sessRow?.id) {
            const gate = await evaluateAdminLoginGate(deps.db, deps.env, {
              headers: c.req.raw.headers,
              sessionId: sessRow.id,
              userId: userRow.id,
              userEmail: userRow.email,
              userName: userRow.name,
              loginId: loginMonitor.loginId,
            });
            if (gate.newDeviceCookieValue) {
              const isHttps =
                c.req.url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https';
              const nextHeaders = new Headers(authRes.headers);
              nextHeaders.append(
                'Set-Cookie',
                buildAdminDeviceCookieHeader(gate.newDeviceCookieValue, isHttps)
              );
              return new Response(authRes.body, {
                status: authRes.status,
                statusText: authRes.statusText,
                headers: nextHeaders,
              });
            }
          }
        }
        return authRes;
      });
    }

    const authRes = await deps.auth.handler(c.req.raw);

    // Post-auth outcome auditing & Layer 3 new-device alerting + Strict Admin Device/IP Gate
    if (path === '/api/auth/callback/google') {
      const issuedToken = extractIssuedSessionToken(authRes.headers.get('set-cookie'));
      if (issuedToken) {
        const sess = await deps.db.get<{ id: string; userId: string }>(
          `SELECT id, userId FROM session WHERE token = ?`,
          [issuedToken]
        );
        if (sess?.userId) {
          const userRow = await deps.db.get<{
            id: string;
            name: string;
            email: string;
            role: string;
          }>(`SELECT id, name, email, role FROM user WHERE id = ?`, [sess.userId]);
          if (userRow) {
            const loginMonitor = await recordLoginAttemptAndMonitor(deps.db, deps.env, {
              headers: c.req.raw.headers,
              userId: userRow.id,
              email: userRow.email,
              userName: userRow.name,
              userRole: userRow.role,
              authMethod: 'google_oauth',
              outcome: 'success',
              sessionId: sess.id,
            });
            if (userRow.role !== 'customer') {
              const gate = await evaluateAdminLoginGate(deps.db, deps.env, {
                headers: c.req.raw.headers,
                sessionId: sess.id,
                userId: userRow.id,
                userEmail: userRow.email,
                userName: userRow.name,
                loginId: loginMonitor.loginId,
              });
              if (gate.newDeviceCookieValue) {
                const isHttps =
                  c.req.url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https';
                const nextHeaders = new Headers(authRes.headers);
                nextHeaders.append(
                  'Set-Cookie',
                  buildAdminDeviceCookieHeader(gate.newDeviceCookieValue, isHttps)
                );
                return new Response(authRes.body, {
                  status: authRes.status,
                  statusText: authRes.statusText,
                  headers: nextHeaders,
                });
              }
            }
          }
        }
      }
    } else if (method === 'POST' && path === '/api/auth/change-password' && authRes.ok) {
      const currentUser = await getSessionUser(deps.auth, deps.db, c.req.raw.headers);
      if (currentUser) {
        await recordSecurityEvent(deps.db, {
          userId: currentUser.id,
          email: currentUser.email,
          eventCategory: 'password_changed',
          severity: currentUser.role === 'owner' ? 'high' : 'medium',
          riskLevel: 'low',
          status: 'resolved',
          ipAddress: ip,
          userAgent: c.req.header('user-agent') || null,
        });
      }
    } else if (
      method === 'POST' &&
      path === '/api/auth/change-email' &&
      authRes.ok &&
      changeEmailActor?.role === 'owner'
    ) {
      const newEmail =
        typeof parsedBody.newEmail === 'string' ? parsedBody.newEmail.trim().toLowerCase() : '';
      await writeAuditLog(deps.db, {
        actorId: changeEmailActor.id,
        actorEmail: changeEmailActor.email,
        actorRole: 'owner',
        action: 'OWNER_EMAIL_CHANGE_REQUESTED',
        targetType: 'user',
        targetId: changeEmailActor.id,
        details: { newEmail },
        ipAddress: ip,
      });
      await recordSecurityEvent(deps.db, {
        userId: changeEmailActor.id,
        email: changeEmailActor.email,
        eventCategory: 'owner_email_change_requested',
        severity: 'high',
        riskLevel: 'medium',
        status: 'recorded',
        ipAddress: ip,
        userAgent: c.req.header('user-agent') || null,
        metadata: { newEmail },
      });
    }

    return authRes;
  });

  // Public product media served from R2/local storage (never serves /receipts/)
  app.get('/api/media/products/:file', async (c) => {
    const file = c.req.param('file').replace(/[^a-zA-Z0-9._-]/g, '');
    const obj = await deps.storage.get(`products/${file}`);
    if (!obj) return c.json({ error: 'Media not found' }, 404);
    return new Response(new Uint8Array(obj.data), {
      headers: {
        'Content-Type': obj.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  // Fail-Closed Hardened Brevo Delivery Webhook
  app.post('/api/webhooks/brevo', async (c) => {
    const ip = getTrustedClientIp(c.req.raw.headers, deps.env);
    const rl = await checkPersistentRateLimit(deps.db, `webhook:brevo:${ip}`, 120, 60_000);
    if (!rl.allowed) return c.json({ error: 'Too many requests' }, 429);

    const secret = deps.env.brevoWebhookSecret?.trim();
    if (!secret) {
      return c.json({ error: 'Webhook verification secret not configured.' }, 503);
    }

    const supplied = (c.req.header('x-brevo-secret') || c.req.query('secret') || '').trim();
    if (!supplied || !timingSafeEqualStr(supplied, secret)) {
      await recordSecurityEvent(deps.db, {
        eventCategory: 'webhook_unauthorized',
        severity: 'high',
        riskLevel: 'high',
        ipAddress: ip,
        metadata: { endpoint: '/api/webhooks/brevo' },
      });
      return c.json({ error: 'Unauthorized webhook' }, 401);
    }

    const rawBody = await c.req.json().catch(() => null);
    const schema = z.object({
      event: z.string().max(64).optional(),
      'message-id': z.string().max(256).optional(),
      messageId: z.string().max(256).optional(),
      reason: z.string().max(400).optional(),
    });
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: 'Invalid webhook payload' }, 400);
    }

    const msgId = parsed.data['message-id'] || parsed.data.messageId;
    if (!msgId) return c.json({ ok: true });

    let mapped: 'delivered' | 'bounced' | 'sent' | null = null;
    if (parsed.data.event === 'delivered') mapped = 'delivered';
    else if (
      parsed.data.event === 'hard_bounce' ||
      parsed.data.event === 'soft_bounce' ||
      parsed.data.event === 'blocked'
    ) {
      mapped = 'bounced';
    } else if (parsed.data.event === 'request' || parsed.data.event === 'sent') {
      mapped = 'sent';
    }

    if (mapped) {
      await deps.db.run(
        `UPDATE email_notification_events SET status = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE provider_message_id = ?`,
        [mapped, parsed.data.reason || null, new Date().toISOString(), msgId]
      );
    }
    return c.json({ ok: true });
  });

  // Mount modular route groups under /api
  app.route('/api', createPublicRoutes());
  app.route('/api', createCustomerRoutes());
  app.route('/api', createOrderRoutes());
  app.route('/api', createSecurityRoutes());
  app.route('/api/admin', createAdminRoutes());
  app.route('/api/developer', createDeveloperRoutes());

  return app;
}
