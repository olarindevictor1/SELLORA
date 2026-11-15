import { Hono } from 'hono';
import type { AppContext, AppEnvConfig } from './context';
import type { SelloraDb, SelloraStorage } from './db';
import { createSelloraAuth, getSessionUser } from './auth';
import { isTurnstileConfigured, verifyTurnstileToken } from './security';
import { createPublicRoutes } from './routes/public';
import { createCustomerRoutes } from './routes/customer';
import { createOrderRoutes } from './routes/orders';
import { createAdminRoutes } from './routes/admin';

const TURNSTILE_PROTECTED_AUTH_PATHS = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-up/email',
  '/api/auth/request-password-reset',
  '/api/auth/forget-password',
]);

export function createSelloraApiApp(deps: {
  db: SelloraDb;
  storage: SelloraStorage;
  auth: ReturnType<typeof createSelloraAuth>;
  env: AppEnvConfig;
}) {
  const app = new Hono<AppContext>();

  // Security headers & dependency injection
  app.use('*', async (c, next) => {
    c.set('db', deps.db);
    c.set('storage', deps.storage);
    c.set('auth', deps.auth);
    c.set('env', deps.env);

    // Resolve Better Auth session user on API routes
    if (!c.req.path.startsWith('/api/auth/')) {
      const user = await getSessionUser(deps.auth, deps.db, c.req.raw.headers);
      c.set('user', user);
    } else {
      c.set('user', null);
    }

    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (c.req.path.startsWith('/api/auth/') || c.req.path.startsWith('/api/admin/')) {
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

  // Server-side Turnstile & reserved owner email protection before Better Auth
  app.all('/api/auth/*', async (c) => {
    if (c.req.method === 'POST' && c.req.path === '/api/auth/sign-up/email') {
      const ownerEmail = deps.env.ownerEmail?.trim().toLowerCase();
      if (ownerEmail) {
        try {
          const cloned = c.req.raw.clone();
          const body = (await cloned.json()) as { email?: string };
          if (typeof body?.email === 'string' && body.email.trim().toLowerCase() === ownerEmail) {
            return c.json(
              {
                error:
                  'This email is reserved for the store owner. Sign in with your owner password or verified Google account.',
              },
              403
            );
          }
        } catch {
          // let Better Auth validate malformed payload
        }
      }
    }

    if (
      c.req.method === 'POST' &&
      TURNSTILE_PROTECTED_AUTH_PATHS.has(c.req.path) &&
      isTurnstileConfigured(deps.env)
    ) {
      let token = c.req.header('x-turnstile-token') || undefined;
      if (!token) {
        try {
          const cloned = c.req.raw.clone();
          const body = (await cloned.json()) as { turnstileToken?: string };
          token = body?.turnstileToken;
        } catch {
          token = undefined;
        }
      }
      const ip = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'local';
      const check = await verifyTurnstileToken({
        token,
        secretKey: deps.env.turnstileSecretKey,
        siteKey: deps.env.turnstileSiteKey,
        remoteIp: ip,
      });
      if (!check.ok) {
        return c.json({ error: check.error || 'Bot verification failed.' }, 400);
      }
    }
    return deps.auth.handler(c.req.raw);
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
      },
    });
  });

  // Brevo Delivery Webhook (updates delivered/bounced only on real provider events)
  app.post('/api/webhooks/brevo', async (c) => {
    const secret = deps.env.brevoWebhookSecret;
    if (secret) {
      const supplied = c.req.header('x-brevo-secret') || c.req.query('secret');
      if (supplied !== secret) return c.json({ error: 'Unauthorized webhook' }, 401);
    }
    const payload = (await c.req.json().catch(() => ({}))) as {
      event?: string;
      'message-id'?: string;
      messageId?: string;
      reason?: string;
    };
    const msgId = payload['message-id'] || payload.messageId;
    if (!msgId) return c.json({ ok: true });

    let mapped: 'delivered' | 'bounced' | 'sent' | null = null;
    if (payload.event === 'delivered') mapped = 'delivered';
    else if (payload.event === 'hard_bounce' || payload.event === 'soft_bounce' || payload.event === 'blocked')
      mapped = 'bounced';
    else if (payload.event === 'request' || payload.event === 'sent') mapped = 'sent';

    if (mapped) {
      await deps.db.run(
        `UPDATE email_notification_events SET status = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE provider_message_id = ?`,
        [mapped, payload.reason || null, new Date().toISOString(), msgId]
      );
    }
    return c.json({ ok: true });
  });

  // Mount modular route groups under /api
  app.route('/api', createPublicRoutes());
  app.route('/api', createCustomerRoutes());
  app.route('/api', createOrderRoutes());
  app.route('/api/admin', createAdminRoutes());

  return app;
}
