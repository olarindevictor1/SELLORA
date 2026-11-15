import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { createSqliteDb, createLocalStorage } from './src/server/db-node';
import { seedInitialStoreData } from './src/server/seed';
import { createSelloraAuth } from './src/server/auth';
import { createSelloraApiApp } from './src/server/app';
import { generateRobotsTxt, generateSitemapXml, renderSeoHtmlResponse } from './src/server/seo';
import type { AppEnvConfig } from './src/server/context';

async function startServer() {
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  const dbPath = process.env.SQLITE_DB_PATH || './.data/sellora.db';
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  const db = createSqliteDb(dbPath, migrationsDir);
  const storage = createLocalStorage(path.resolve(process.cwd(), '.data/r2'));

  await seedInitialStoreData(db);

  // Use BETTER_AUTH_SECRET from env, or persist an ephemeral dev secret locally in .data/auth-secret
  let authSecret = process.env.BETTER_AUTH_SECRET || '';
  if (!authSecret || authSecret.startsWith('REPLACE_WITH')) {
    const secretFile = path.resolve(process.cwd(), '.data/.auth-secret');
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    if (fs.existsSync(secretFile)) {
      authSecret = fs.readFileSync(secretFile, 'utf8').trim();
    } else {
      authSecret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(secretFile, authSecret, { mode: 0o600 });
    }
  }

  const appUrl = (process.env.APP_URL || `http://localhost:${port}`).trim();
  const envConfig: AppEnvConfig = {
    betterAuthSecret: authSecret,
    ownerEmail: (process.env.OWNER_EMAIL || 'olarindevictor3@gmail.com').trim(),
    brevoApiKey: process.env.BREVO_API_KEY?.trim() || undefined,
    brevoFromEmail: process.env.BREVO_FROM_EMAIL?.trim() || undefined,
    brevoFromName: (process.env.BREVO_FROM_NAME || 'SELLORA').trim(),
    adminNotificationEmail:
      (process.env.ADMIN_NOTIFICATION_EMAIL || 'olarindevictor3@gmail.com').trim(),
    brevoWebhookSecret: process.env.BREVO_WEBHOOK_SECRET?.trim() || undefined,
    turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY?.trim() || undefined,
    turnstileSiteKey:
      (process.env.VITE_TURNSTILE_SITE_KEY || process.env.TURNSTILE_SITE_KEY || '').trim() ||
      undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || undefined,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
    googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION?.trim() || undefined,
    gaMeasurementId:
      (process.env.VITE_GA_MEASUREMENT_ID || process.env.GA_MEASUREMENT_ID || '').trim() ||
      undefined,
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
    appUrl,
  };

  if (!db.rawSqlite) {
    throw new Error('SQLite connection required for Node server runtime.');
  }

  const auth = createSelloraAuth({
    database: db.rawSqlite,
    db,
    baseURL: appUrl,
    secret: authSecret,
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

  const app = express();
  app.set('trust proxy', true);

  // Dynamic robots.txt and XML Sitemap backed by store_settings.seo & real active DB records
  app.get('/robots.txt', async (req, res) => {
    const fallbackOrigin = `${req.protocol}://${req.get('host') || `localhost:${port}`}`;
    const txt = await generateRobotsTxt(db, envConfig, fallbackOrigin);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(txt);
  });

  app.get('/sitemap.xml', async (req, res) => {
    const fallbackOrigin = `${req.protocol}://${req.get('host') || `localhost:${port}`}`;
    const xml = await generateSitemapXml(db, envConfig, fallbackOrigin);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  });

  // Bridge Express /api/* requests directly into the Hono Web-Standard API App
  app.use('/api', async (req, res) => {
    try {
      const origin = `${req.protocol}://${req.get('host') || `localhost:${port}`}`;
      const url = new URL(req.originalUrl, origin);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) {
          headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        }
      }

      const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase());
      const bodyStream = hasBody
        ? await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
          })
        : undefined;

      const webReq = new Request(url.toString(), {
        method: req.method,
        headers,
        body: bodyStream ? new Uint8Array(bodyStream) : undefined,
      });

      const webRes = await apiApp.fetch(webReq);
      res.status(webRes.status);
      webRes.headers.forEach((val, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          res.append('Set-Cookie', val);
        } else {
          res.setHeader(key, val);
        }
      });
      const buf = Buffer.from(await webRes.arrayBuffer());
      res.send(buf);
    } catch (err) {
      console.error('[SELLORA API Error]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  const httpServer = http.createServer(app);

  // Mount Vite middleware in dev or serve static dist/ in production with dynamic SEO head tags
  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: { server: httpServer },
      },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.get('*', async (req, res, next) => {
      try {
        const origin = `${req.protocol}://${req.get('host') || `localhost:${port}`}`;
        const url = new URL(req.originalUrl, origin);
        const template = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
        const transformed = await vite.transformIndexHtml(req.originalUrl, template);
        const { html: withSeo, status } = await renderSeoHtmlResponse(transformed, url, db, envConfig);
        res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(withSeo);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir, { index: false }));
    app.get('*', async (req, res) => {
      const origin = `${req.protocol}://${req.get('host') || `localhost:${port}`}`;
      const url = new URL(req.originalUrl, origin);
      const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
      const { html: withSeo, status } = await renderSeoHtmlResponse(html, url, db, envConfig);
      res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(withSeo);
    });
  }

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`SELLORA server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start SELLORA server:', err);
  process.exit(1);
});
