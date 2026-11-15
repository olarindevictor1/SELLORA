import { createD1Db, createR2Storage, type D1LikeDatabase, type R2LikeBucket } from '../src/server/db';
import { seedInitialStoreData } from '../src/server/seed';
import { createSelloraAuth } from '../src/server/auth';
import { createSelloraApiApp } from '../src/server/app';
import { processEmailOutbox } from '../src/server/email';
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
}

let seededPromise: Promise<void> | null = null;

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
    ownerEmail: (env.OWNER_EMAIL || 'olarindevictor3@gmail.com').trim(),
    brevoApiKey: env.BREVO_API_KEY?.trim() || undefined,
    brevoFromEmail: env.BREVO_FROM_EMAIL?.trim() || undefined,
    brevoFromName: (env.BREVO_FROM_NAME || 'SELLORA').trim(),
    adminNotificationEmail:
      (env.ADMIN_NOTIFICATION_EMAIL || 'olarindevictor3@gmail.com').trim(),
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
  };
}

/**
 * Cloudflare Worker Entry Point for Production Deployment.
 * Runs the full SELLORA Hono API + Better Auth directly on Cloudflare D1 (env.DB),
 * R2 (env.R2_MEDIA), and Workers Static Assets (env.ASSETS).
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const db = createD1Db(env.DB);
    const envConfig = buildEnvConfig(env, url);

    if (url.pathname === '/api/health') {
      await db.get('SELECT 1 as ok');
      return Response.json({
        ok: true,
        runtime: 'cloudflare-workers',
        database: 'cloudflare-d1',
        timezone: 'Africa/Lagos',
        currency: 'NGN',
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === '/robots.txt') {
      const txt = await generateRobotsTxt(db, envConfig, url.origin);
      return new Response(txt, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/sitemap.xml') {
      const xml = await generateSitemapXml(db, envConfig, url.origin);
      return new Response(xml, {
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.startsWith('REPLACE_WITH')) {
        return Response.json(
          { error: 'BETTER_AUTH_SECRET must be configured in Cloudflare Workers secrets.' },
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
      return new Response(injected, {
        status: status === 404 ? 404 : assetRes.status,
        statusText: status === 404 ? 'Not Found' : assetRes.statusText,
        headers: nextHeaders,
      });
    }

    return assetRes;
  },

  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    const db = createD1Db(env.DB);
    await processEmailOutbox(db, {
      brevoApiKey: env.BREVO_API_KEY,
      brevoFromEmail: env.BREVO_FROM_EMAIL,
      brevoFromName: env.BREVO_FROM_NAME,
      adminNotificationEmail:
        env.ADMIN_NOTIFICATION_EMAIL || 'olarindevictor3@gmail.com',
      appUrl: env.APP_URL,
    });
  },
};
