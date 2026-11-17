import { createD1Db, createR2Storage, type D1LikeDatabase, type R2LikeBucket } from '../src/server/db';
import { seedInitialStoreData } from '../src/server/seed';
import { createSelloraAuth } from '../src/server/auth';
import { createSelloraApiApp } from '../src/server/app';
import { processEmailOutbox } from '../src/server/email';
import { recordCapturedError } from '../src/server/error-monitor';
import { resolveMaxLockoutSeconds } from '../src/server/security';
import { generateRobotsTxt, generateSitemapXml, renderSeoHtmlResponse } from '../src/server/seo';
import type { AppEnvConfig } from '../src/server/context';

export interface WorkerEnv {
  DB: D1LikeDatabase;
  R2_MEDIA: R2LikeBucket;
  ASSETS: { fetch(request: Request): Promise<Response> };
  APP_URL?: string;
  BETTER_AUTH_SECRET?: string;
  OWNER_EMAIL?: string;
  BREVO_API_KEY?: string;
  BREVO_FROM_EMAIL?: string;
  BREVO_FROM_NAME?: string;
  ADMIN_NOTIFICATION_EMAIL?: string;
  BREVO_WEBHOOK_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  VITE_TURNSTILE_SITE_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_SITE_VERIFICATION?: string;
  VITE_GA_MEASUREMENT_ID?: string;
  GA_MEASUREMENT_ID?: string;
  GEMINI_API_KEY?: string;
  LOGIN_MAX_LOCKOUT_SECONDS?: string;
  CORS_ALLOWED_ORIGINS?: string;
}

let seededPromise: Promise<void> | null = null;

function parseAllowedOriginsList(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function hasValidD1Binding(db: unknown): db is D1LikeDatabase {
  return Boolean(
    db &&
      typeof (db as D1LikeDatabase).prepare === 'function' &&
      typeof (db as D1LikeDatabase).batch === 'function'
  );
}

function hasValidR2Binding(bucket: unknown): bucket is R2LikeBucket {
  return Boolean(
    bucket &&
      typeof (bucket as R2LikeBucket).get === 'function' &&
      typeof (bucket as R2LikeBucket).put === 'function' &&
      typeof (bucket as R2LikeBucket).delete === 'function'
  );
}

function buildEnvConfig(env: WorkerEnv, requestUrl: URL): AppEnvConfig {
  const configuredUrl = (env.APP_URL || '').trim();
  const appUrl = (
    configuredUrl &&
    !configuredUrl.includes('your-sellora-domain') &&
    !configuredUrl.includes('REPLACE_WITH')
      ? configuredUrl
      : requestUrl.origin
  ).replace(/\/+$/, '');
  return {
    betterAuthSecret: (env.BETTER_AUTH_SECRET || '').trim(),
    ownerEmail: (env.OWNER_EMAIL || 'olarindevictor046@gmail.com').trim(),
    brevoApiKey: env.BREVO_API_KEY?.trim() || undefined,
    brevoFromEmail: env.BREVO_FROM_EMAIL?.trim() || undefined,
    brevoFromName: (env.BREVO_FROM_NAME || 'SELLORA').trim(),
    adminNotificationEmail:
      (env.ADMIN_NOTIFICATION_EMAIL || 'olarindevictor046@gmail.com').trim(),
    brevoWebhookSecret: env.BREVO_WEBHOOK_SECRET?.trim() || undefined,
    turnstileSecretKey: env.TURNSTILE_SECRET_KEY?.trim() || undefined,
    turnstileSiteKey:
      (env.TURNSTILE_SITE_KEY || env.VITE_TURNSTILE_SITE_KEY || '').trim() || undefined,
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
    googleSiteVerification: env.GOOGLE_SITE_VERIFICATION?.trim() || undefined,
    gaMeasurementId:
      (env.VITE_GA_MEASUREMENT_ID || env.GA_MEASUREMENT_ID || '').trim() || undefined,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
    appUrl,
    runtime: 'worker',
    environment: 'production',
    trustedProxy: true,
    loginMaxLockoutSeconds: resolveMaxLockoutSeconds(env.LOGIN_MAX_LOCKOUT_SECONDS),
    corsAllowedOrigins: parseAllowedOriginsList(env.CORS_ALLOWED_ORIGINS),
  };
}

function applyHtmlSecurityHeaders(headers: Headers, isHttps: boolean): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https://challenges.cloudflare.com https://www.google-analytics.com https://*.google-analytics.com; frame-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'"
  );
  if (isHttps) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/**
 * Cloudflare Worker Entry Point for Production Deployment.
 * Runs the full SELLORA Hono API + Better Auth directly on Cloudflare D1 (env.DB),
 * R2 (env.R2_MEDIA), and Workers Static Assets (env.ASSETS).
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (!hasValidD1Binding(env?.DB)) {
      return Response.json(
        { error: 'Production database binding (DB) is not configured.' },
        { status: 503 }
      );
    }

    const db = createD1Db(env.DB);
    const envConfig = buildEnvConfig(env, url);

    try {
      if (url.pathname === '/api/health') {
        await db.get('SELECT 1 as ok');
        const r2Connected = hasValidR2Binding(env.R2_MEDIA);
        return Response.json(
          {
            ok: r2Connected,
            service: 'sellora-api',
            timezone: 'Africa/Lagos',
            currency: 'NGN',
            timestamp: new Date().toISOString(),
          },
          {
            status: r2Connected ? 200 : 503,
            headers: {
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'strict-origin-when-cross-origin',
            },
          }
        );
      }

      if (url.pathname === '/robots.txt') {
        const txt = await generateRobotsTxt(db, envConfig, url.origin);
        return new Response(txt, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }

      if (url.pathname === '/sitemap.xml') {
        const xml = await generateSitemapXml(db, envConfig, url.origin);
        return new Response(xml, {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }

      if (url.pathname.startsWith('/api/')) {
        if (!hasValidR2Binding(env.R2_MEDIA)) {
          return Response.json(
            { error: 'Production object storage binding (R2_MEDIA) is not configured.' },
            { status: 503 }
          );
        }
        if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.startsWith('REPLACE_WITH')) {
          return Response.json(
            { error: 'Authentication service is not configured.' },
            { status: 503 }
          );
        }

        if (!seededPromise) {
          seededPromise = seedInitialStoreData(db).catch((err) => {
            seededPromise = null;
            throw err;
          });
        }
        await seededPromise;

        const storage = createR2Storage(env.R2_MEDIA);
        const auth = createSelloraAuth({
          database: env.DB,
          db,
          baseURL: envConfig.appUrl!,
          secret: envConfig.betterAuthSecret,
          emailEnv: envConfig,
          ownerEmail: envConfig.ownerEmail,
          googleClientId: envConfig.googleClientId,
          googleClientSecret: envConfig.googleClientSecret,
          corsAllowedOrigins: envConfig.corsAllowedOrigins,
        });
        const apiApp = createSelloraApiApp({
          db,
          storage,
          auth,
          env: envConfig,
        });

        return apiApp.fetch(request);
      }

      const assetRes = await env.ASSETS.fetch(request);
      const contentType = assetRes.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const rawHtml = await assetRes.text();
        const { html: injected, status } = await renderSeoHtmlResponse(rawHtml, url, db, envConfig);
        const nextHeaders = new Headers(assetRes.headers);
        nextHeaders.delete('content-length');
        applyHtmlSecurityHeaders(nextHeaders, url.protocol === 'https:');
        return new Response(injected, {
          status: status === 404 ? 404 : assetRes.status,
          statusText: status === 404 ? 'Not Found' : assetRes.statusText,
          headers: nextHeaders,
        });
      }

      return assetRes;
    } catch (err) {
      const captured = await recordCapturedError(db, {
        serviceCategory: 'api',
        failedOperation: 'worker_fetch',
        location: url.pathname,
        environment: 'production',
        correlationId: request.headers.get('cf-ray') || null,
        error: err,
      });
      if (url.pathname.startsWith('/api/')) {
        return Response.json(
          { error: 'Service temporarily unavailable.', referenceId: captured.refId },
          { status: 500 }
        );
      }
      return new Response(
        `Something went wrong. Please retry shortly (Reference: ${captured.refId}).`,
        { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }
  },

  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    if (!hasValidD1Binding(env?.DB)) {
      throw new Error('Production database binding (DB) is not configured for scheduled task.');
    }
    const db = createD1Db(env.DB);
    await processEmailOutbox(db, {
      brevoApiKey: env.BREVO_API_KEY,
      brevoFromEmail: env.BREVO_FROM_EMAIL,
      brevoFromName: env.BREVO_FROM_NAME,
      adminNotificationEmail:
        env.ADMIN_NOTIFICATION_EMAIL || 'olarindevictor046@gmail.com',
      appUrl: env.APP_URL,
    });
  },
};
