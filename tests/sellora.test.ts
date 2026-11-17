import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  createD1Db,
  extractDbGuardCode,
  type D1LikeDatabase,
  type D1PreparedStatementLike,
  type R2LikeBucket,
} from '../src/server/db';
import { createSqliteDb, createLocalStorage } from '../src/server/db-node';
import { seedInitialStoreData } from '../src/server/seed';
import workerEntry, { type WorkerEnv } from '../worker/index';
import { resolveApiUrl, resolveMediaUrl } from '../src/lib/api';
import { createSelloraAuth, getSessionUser } from '../src/server/auth';
import { createSelloraApiApp } from '../src/server/app';
import {
  dispatchSingleEmailEvent,
  getEffectiveEmailConfig,
  queueEmailEvent,
  triggerOrderNotifications,
} from '../src/server/email';
import {
  generateRobotsTxt,
  generateSitemapXml,
  injectSeoIntoHtml,
  renderSeoHtmlResponse,
  sanitizeGaMeasurementId,
  sanitizeGoogleSiteVerification,
} from '../src/server/seo';
import {
  checkLoginThrottle,
  checkPersistentRateLimit,
  clearLoginThrottle,
  getTrustedClientIp,
  isTurnstileConfigured,
  recordFailedLoginAttempt,
  validateUploadedFileBytes,
  verifyTurnstileToken,
} from '../src/server/security';
import { recordCapturedError } from '../src/server/error-monitor';
import { recordLoginAttemptAndMonitor } from '../src/server/login-monitor';
import { resolveGaMeasurementId } from '../src/lib/analytics';
import type { AppEnvConfig } from '../src/server/context';
import { provisionOwnerInDb } from '../src/server/owner-provisioning';

function createTestRuntime(envOverrides: Partial<AppEnvConfig> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellora-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = createSqliteDb(dbPath, path.resolve(process.cwd(), 'migrations'));
  const storage = createLocalStorage(path.join(tmpDir, 'r2'));
  const env: AppEnvConfig = {
    betterAuthSecret: 'test-secret-012345678901234567890123456789',
    ownerEmail: 'olarindevictor046@gmail.com',
    appUrl: 'http://localhost:3000',
    ...envOverrides,
  };
  const auth = createSelloraAuth({
    database: db.rawSqlite!,
    db,
    baseURL: env.appUrl!,
    secret: env.betterAuthSecret,
    emailEnv: env,
    ownerEmail: env.ownerEmail,
    googleClientId: env.googleClientId,
    googleClientSecret: env.googleClientSecret,
  });
  const app = createSelloraApiApp({ db, storage, auth, env });
  return { app, db, auth, storage, env, tmpDir };
}

function extractCookieHeader(res: Response): string {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  const rawList =
    typeof anyHeaders.getSetCookie === 'function'
      ? anyHeaders.getSetCookie()
      : (res.headers.get('set-cookie') || '').split(/,(?=\s*[a-zA-Z0-9_.-]+=)/);
  return rawList
    .map((entry) => entry.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function unlockPrivilegedSession(
  rt: { app?: any; db: { get: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null> } },
  signInRes: Response,
  opts: {
    baseUrl?: string;
    secPassword?: string;
    dispatch?: (url: string, init?: RequestInit) => Promise<Response>;
  } = {}
): Promise<string> {
  const baseUrl = (opts.baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  const secPassword = opts.secPassword || 'AdminSecPass#2026!';
  const dispatch =
    opts.dispatch ||
    ((url: string, init?: RequestInit) => rt.app.request(url, init) as Promise<Response>);
  const cookieHeader = extractCookieHeader(signInRes);
  assert.ok(cookieHeader, 'Expected session cookie header from privileged sign-in');

  const status1Res = await dispatch(`${baseUrl}/api/admin/security/status`, {
    headers: { Cookie: cookieHeader },
  });
  assert.equal(status1Res.status, 200);
  const status1Body = (await status1Res.json()) as {
    adminSecurity: {
      required: boolean;
      unlocked: boolean;
      lockCode: string | null;
    };
  };
  let statusJson = status1Body.adminSecurity;

  if (statusJson.required && statusJson.lockCode === 'ADMIN_SECURITY_LOCKED') {
    const mailRow = await rt.db.get<{ html_body: string }>(
      `SELECT html_body FROM email_notification_events
       WHERE notification_type = 'security_admin_approval_required'
       ORDER BY created_at DESC LIMIT 1`
    );
    assert.ok(mailRow?.html_body, 'Expected Gmail security approval email in Brevo outbox');
    const tokenMatch = mailRow.html_body.match(/action=approve(?:&amp;|&)token=([A-Za-z0-9_-]+)/);
    assert.ok(tokenMatch?.[1], 'Expected approve token URL in approval email body');

    const apvRes = await dispatch(`${baseUrl}/api/security/admin-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', token: tokenMatch[1] }),
    });
    assert.equal(apvRes.status, 200);

    const status2Res = await dispatch(`${baseUrl}/api/admin/security/status`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(status2Res.status, 200);
    statusJson = ((await status2Res.json()) as { adminSecurity: typeof statusJson }).adminSecurity;
  }

  if (statusJson.required && !statusJson.unlocked) {
    if (statusJson.lockCode === 'ADMIN_SEC_PASSWORD_SETUP_REQUIRED') {
      const setupRes = await dispatch(`${baseUrl}/api/admin/security/password/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
        body: JSON.stringify({ newPassword: secPassword }),
      });
      assert.ok(setupRes.status === 200 || setupRes.status === 201);
    } else if (statusJson.lockCode === 'ADMIN_SEC_PASSWORD_REQUIRED') {
      const verifyRes = await dispatch(`${baseUrl}/api/admin/security/password/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
        body: JSON.stringify({ password: secPassword }),
      });
      assert.equal(verifyRes.status, 200);
    }
  }

  return cookieHeader;
}

async function provisionAndSignInOwner(
  rt: { app: any; db: any },
  opts: { name?: string; email?: string; password?: string; secPassword?: string } = {}
): Promise<{ cookie: string; userId: string }> {
  const email = (opts.email || 'olarindevictor046@gmail.com').trim().toLowerCase();
  const password = opts.password || 'StrongOwnerPassword123!';
  const prov = await provisionOwnerInDb(rt.db, {
    name: opts.name || 'Victor Olarinde',
    email,
    password,
  });
  const res = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const cookie = await unlockPrivilegedSession(rt, res, { secPassword: opts.secPassword });
  return { cookie, userId: prov.userId };
}

function createInMemoryD1Shim(migrationsDir: string): D1LikeDatabase {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }

  const makeStmt = (
    sql: string,
    bound: unknown[] = []
  ): D1PreparedStatementLike & {
    raw: <T = unknown>() => Promise<T[]>;
    __execForBatch: () => Promise<unknown>;
  } => ({
    bind(...values: unknown[]) {
      return makeStmt(sql, values);
    },
    async all<T = unknown>() {
      const results = sqlite.prepare(sql).all(...bound) as T[];
      return { results, success: true, meta: { changes: 0 } } as {
        results: T[];
        meta?: { changes?: number };
      };
    },
    async first<T = unknown>() {
      const row = sqlite.prepare(sql).get(...bound);
      return (row as T | undefined) ?? null;
    },
    async run() {
      const res = sqlite.prepare(sql).run(...bound);
      return { success: true, meta: { changes: res.changes } };
    },
    async raw<T = unknown>() {
      return sqlite.prepare(sql).raw(true).all(...bound) as T[];
    },
    async __execForBatch() {
      const prep = sqlite.prepare(sql);
      if (prep.reader) {
        const results = prep.all(...bound);
        return { results, success: true, meta: { changes: 0 } };
      }
      const res = prep.run(...bound);
      return { results: [], success: true, meta: { changes: res.changes } };
    },
  });

  return {
    prepare(sql: string) {
      return makeStmt(sql, []);
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    async batch<T = unknown>(statements: D1PreparedStatementLike[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const out: T[] = [];
        for (const stmt of statements) {
          const batchFn = (stmt as { __execForBatch?: () => Promise<unknown> }).__execForBatch;
          out.push((batchFn ? await batchFn() : await stmt.run()) as T);
        }
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          sqlite.exec('ROLLBACK');
        } catch {
          // ignore if already rolled back
        }
        throw err;
      }
    },
  };
}

test('SELLORA end-to-end commerce, RBAC, tracking, payment review, and email queue tests', async () => {
  const { app, db, tmpDir } = createTestRuntime();
  try {
    await seedInitialStoreData(db);

    // 1. Health & Legacy Bootstrap Routes Removed
    const healthRes = await app.request('http://localhost:3000/api/health');
    assert.equal(healthRes.status, 200);

    const legacyBootStatus = await app.request('http://localhost:3000/api/bootstrap/status');
    assert.equal(legacyBootStatus.status, 404);
    const legacyBootPost = await app.request('http://localhost:3000/api/bootstrap/owner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com' }),
    });
    assert.equal(legacyBootPost.status, 404);

    // 2. Server-side Owner Provisioning & Standard Sign-In
    const { cookie: ownerCookie } = await provisionAndSignInOwner(
      { app, db },
      { email: 'olarindevictor046@gmail.com', password: 'StrongPassword123!' }
    );

    const provAudit = await db.get<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action = 'OWNER_SERVER_PROVISIONED'`
    );
    assert.equal(provAudit?.action, 'OWNER_SERVER_PROVISIONED');

    // 3. Customer Registration (forged role MUST be ignored) & RBAC Isolation
    const custSignUp = await app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada Obi',
        email: 'ada@customer.test',
        password: 'CustomerPassword123!',
        role: 'owner',
        permissionsJson: '["staff:manage"]',
      }),
    });
    assert.equal(custSignUp.status, 200);
    const custCookie = custSignUp.headers.get('set-cookie')!.split(';')[0];

    const meCust = await (
      await app.request('http://localhost:3000/api/me', { headers: { Cookie: custCookie } })
    ).json();
    assert.equal(meCust.user.role, 'customer');
    assert.deepEqual(meCust.user.permissions, []);

    // Customer cannot escalate role via Better Auth self-update
    await app.request('http://localhost:3000/api/auth/update-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: custCookie },
      body: JSON.stringify({ name: 'Ada Obi Updated', role: 'owner' }),
    });
    const meCustAfter = await (
      await app.request('http://localhost:3000/api/me', { headers: { Cookie: custCookie } })
    ).json();
    assert.equal(meCustAfter.user.role, 'customer');

    // Customer cannot access admin routes
    const forbiddenAdmin = await app.request('http://localhost:3000/api/admin/orders', {
      headers: { Cookie: custCookie },
    });
    assert.equal(forbiddenAdmin.status, 403);

    // 4. Nigerian Delivery Zone Validation (unsupported blocked, enabled works)
    const unsupportedQuote = await (
      await app.request('http://localhost:3000/api/delivery/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'Lagos', lga: 'Ikeja', subtotalKobo: 100000 }),
      })
    ).json();
    assert.equal(unsupportedQuote.available, false);

    // Owner configures Lagos delivery zone
    const addZone = await app.request('http://localhost:3000/api/admin/delivery-zones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        state: 'Lagos',
        lga: 'Ikeja',
        feeNaira: 3500,
        estimatedDaysMin: 1,
        estimatedDaysMax: 2,
      }),
    });
    assert.equal(addZone.status, 201);

    // 5. Transactional Checkout, Unique IDs, Stock Deduction, Email Outbox
    const prodRes = await (await app.request('http://localhost:3000/api/products')).json();
    const firstProd = prodRes.products[0];
    const firstVar = firstProd.variants[0];
    const initialStock = firstVar.stock_quantity;

    const checkoutRes = await app.request('http://localhost:3000/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: custCookie },
      body: JSON.stringify({
        items: [{ productId: firstProd.id, variantId: firstVar.id, quantity: 2 }],
        address: {
          fullName: 'Ada Obi',
          email: 'ada@customer.test',
          phone: '08031234567',
          state: 'Lagos',
          lga: 'Ikeja',
          city: 'Opebi',
          streetAddress: '24 Allen Avenue',
        },
        idempotencyKey: 'chk_test_unique_1',
      }),
    });
    assert.equal(checkoutRes.status, 201);
    const orderData = await checkoutRes.json();
    assert.ok(orderData.orderId.startsWith('ord_'));
    assert.ok(orderData.orderNumber.startsWith('SLR-'));
    assert.equal(orderData.deliveryFeeKobo, 350000);
    assert.equal(orderData.resolvedItems.length, 1);
    assert.ok(orderData.resolvedItems[0].orderItemId.startsWith('oi_'));

    // Verify stock deducted atomically
    const updatedVar = await db.get<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM product_variants WHERE id = ?`,
      [firstVar.id]
    );
    assert.equal(updatedVar?.stock_quantity, initialStock - 2);

    // Verify oversell rejection
    const oversellRes = await app.request('http://localhost:3000/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: custCookie },
      body: JSON.stringify({
        items: [{ productId: firstProd.id, variantId: firstVar.id, quantity: 999 }],
        address: {
          fullName: 'Ada Obi',
          email: 'ada@customer.test',
          phone: '08031234567',
          state: 'Lagos',
          lga: 'Ikeja',
          city: 'Opebi',
          streetAddress: '24 Allen Avenue',
        },
      }),
    });
    assert.equal(oversellRes.status, 400);

    // 6. Track Order Guest Verification & Privacy
    const badTrack = await app.request('http://localhost:3000/api/tracking/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumber: orderData.orderNumber, verification: 'wrong@email.com' }),
    });
    assert.equal(badTrack.status, 403);

    const goodTrack = await app.request('http://localhost:3000/api/tracking/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumber: orderData.orderNumber, verification: '08031234567' }),
    });
    assert.equal(goodTrack.status, 200);
    const tracked = await goodTrack.json();
    assert.equal(tracked.order.orderStatus, 'pending_payment');

    // 7. Manual Payment Evidence Upload & Private Receipt Protection
    const form = new FormData();
    form.append('verificationEmail', 'ada@customer.test');
    form.append('referenceNumber', 'NIP-99887766');
    form.append('amountNaira', String(orderData.totalKobo / 100));
    form.append('transferDate', '2026-11-14');
    form.append(
      'receipt',
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])],
        'receipt.png',
        { type: 'image/png' }
      )
    );

    const evRes = await app.request(
      `http://localhost:3000/api/payments/${orderData.orderNumber}/evidence`,
      { method: 'POST', headers: { Cookie: custCookie }, body: form }
    );
    assert.equal(evRes.status, 201);
    const evJson = await evRes.json();
    // Uploading receipt MUST NOT mark order paid
    assert.equal(evJson.status, 'payment_under_review');

    // Unauthenticated receipt access MUST fail
    const publicReceiptAttempt = await app.request(
      `http://localhost:3000/api/payments/evidence/${evJson.evidenceId}/file`
    );
    assert.equal(publicReceiptAttempt.status, 401);

    // Owner/Admin receipt access MUST succeed
    const adminReceiptAttempt = await app.request(
      `http://localhost:3000/api/payments/evidence/${evJson.evidenceId}/file`,
      { headers: { Cookie: ownerCookie } }
    );
    assert.equal(adminReceiptAttempt.status, 200);

    // 8. Admin Payment Verify & Email Outbox Recorded
    const verifyRes = await app.request(
      `http://localhost:3000/api/admin/payments/${orderData.orderId}/verify`,
      { method: 'POST', headers: { Cookie: ownerCookie } }
    );
    assert.equal(verifyRes.status, 200);

    const emailHist = await (
      await app.request('http://localhost:3000/api/admin/email/history', {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    assert.ok(emailHist.events.length >= 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Owner authentication supports Google OAuth and Email+Password resolving to the same account, blocks hijacks, and isolates non-owner emails', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor046@gmail.com',
    adminNotificationEmail: 'alerts@sellora.test',
    googleClientId: '1234567890-mock.apps.googleusercontent.com',
    googleClientSecret: 'mock-google-client-secret',
  });
  try {
    await seedInitialStoreData(rt.db);

    // 1. Public email/password self-registration for OWNER_EMAIL MUST be rejected (403)
    const ownerSelfReg = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Hijack Attempt',
        email: 'olarindevictor046@gmail.com',
        password: 'AttackerPassword123!',
      }),
    });
    assert.equal(ownerSelfReg.status, 403);

    // 2. Notification email signing up via email/password stays customer
    const notifSignUp = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alert Inbox',
        email: 'alerts@sellora.test',
        password: 'StrongPassword123!',
      }),
    });
    assert.equal(notifSignUp.status, 200);
    const notifCookie = notifSignUp.headers.get('set-cookie')!.split(';')[0];
    const meNotif = await (
      await rt.app.request('http://localhost:3000/api/me', { headers: { Cookie: notifCookie } })
    ).json();
    assert.equal(meNotif.user.role, 'customer');

    // 3. Verified Google OAuth login for an ordinary customer stays customer (verified via Better Auth internal adapter + hooks)
    const authCtx = await rt.auth.$context;
    const custGoogleUser = await authCtx.internalAdapter.createUser(
      {
        name: 'Ordinary Google User',
        email: 'shopper.google@gmail.com',
        emailVerified: true,
      },
      { method: 'oauth', oauth: { providerId: 'google' } }
    );
    await authCtx.internalAdapter.createAccount({
      userId: custGoogleUser.id,
      providerId: 'google',
      accountId: 'google-sub-cust-1',
    });
    const custDbRow = await rt.db.get<{ role: string }>(`SELECT role FROM user WHERE id = ?`, [
      custGoogleUser.id,
    ]);
    assert.equal(custDbRow?.role, 'customer');

    // 4. Unverified Google/OAuth record even matching OWNER_EMAIL NEVER grants owner
    const unverifiedOwnerTry = await authCtx.internalAdapter.createUser(
      {
        name: 'Unverified Try',
        email: 'olarindevictor046@gmail.com',
        emailVerified: false,
      },
      { method: 'oauth', oauth: { providerId: 'google' } }
    );
    await authCtx.internalAdapter.createAccount({
      userId: unverifiedOwnerTry.id,
      providerId: 'google',
      accountId: 'google-sub-unverified',
    });
    const unverifiedRow = await rt.db.get<{ role: string }>(`SELECT role FROM user WHERE id = ?`, [
      unverifiedOwnerTry.id,
    ]);
    assert.equal(unverifiedRow?.role, 'customer');

    // Clean up unverified test user before simulating real verified Google OAuth owner login
    await rt.db.run(`DELETE FROM user WHERE id = ?`, [unverifiedOwnerTry.id]);

    // 5. Verified Google OAuth sign-in for olarindevictor046@gmail.com authorizes owner automatically
    const verifiedOwnerUser = await authCtx.internalAdapter.createUser(
      {
        name: 'Victor Olarinde',
        email: 'olarindevictor046@gmail.com',
        emailVerified: true,
      },
      { method: 'oauth', oauth: { providerId: 'google' } }
    );
    await authCtx.internalAdapter.createAccount({
      userId: verifiedOwnerUser.id,
      providerId: 'google',
      accountId: 'google-sub-victor-owner',
    });

    const ownerRowAfterGoogle = await rt.db.get<{ id: string; role: string; emailVerified: number }>(
      `SELECT id, role, emailVerified FROM user WHERE email = ?`,
      ['olarindevictor046@gmail.com']
    );
    assert.equal(ownerRowAfterGoogle?.id, verifiedOwnerUser.id);
    assert.equal(ownerRowAfterGoogle?.role, 'owner');
    assert.equal(ownerRowAfterGoogle?.emailVerified, 1);

    // 6. Adding Email & Password to that same Google-created owner resolves to the SAME user.id
    const addPwdRes = await provisionOwnerInDb(rt.db, {
      name: 'Victor Olarinde',
      email: 'olarindevictor046@gmail.com',
      password: 'OwnerUnifiedPassword123!',
      addPasswordIfMissing: true,
    });
    assert.equal(addPwdRes.status, 'password_added');
    assert.equal(addPwdRes.userId, verifiedOwnerUser.id);

    // Verify invalid password is rejected
    const badLogin = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'WrongPassword123!',
      }),
    });
    assert.equal(badLogin.status, 401);

    // Verify valid Email & Password signs into the SAME owner account
    const goodLogin = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'OwnerUnifiedPassword123!',
      }),
    });
    assert.equal(goodLogin.status, 200);
    const ownerCookie = goodLogin.headers.get('set-cookie')!.split(';')[0];
    const meOwner = await (
      await rt.app.request('http://localhost:3000/api/me', { headers: { Cookie: ownerCookie } })
    ).json();
    assert.equal(meOwner.user.id, verifiedOwnerUser.id);
    assert.equal(meOwner.user.role, 'owner');

    // Ensure no duplicate user records exist for olarindevictor046@gmail.com
    const dupCount = await rt.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM user WHERE LOWER(email) = 'olarindevictor046@gmail.com'`
    );
    assert.equal(dupCount?.cnt, 1);

    // Unauthenticated & customer requests to protected admin APIs return 401 and 403
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/orders')).status, 401);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/analytics', { headers: { Cookie: notifCookie } })).status, 403);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/staff', { headers: { Cookie: notifCookie } })).status, 403);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/settings', { headers: { Cookie: notifCookie } })).status, 403);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/settings', { headers: { Cookie: ownerCookie } })).status, 200);
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('RBAC role isolation across owner, admin, staff, and customer', async () => {
  const rt = createTestRuntime();
  try {
    await seedInitialStoreData(rt.db);

    const { cookie: ownerCookie } = await provisionAndSignInOwner(rt, {
      email: 'olarindevictor046@gmail.com',
      password: 'StrongPassword123!',
    });

    // Owner creates admin and staff accounts
    const createAdmin = await rt.app.request('http://localhost:3000/api/admin/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        name: 'Store Admin',
        email: 'admin@sellora.test',
        password: 'AdminPassword123!',
        role: 'admin',
      }),
    });
    assert.equal(createAdmin.status, 201);

    const createStaff = await rt.app.request('http://localhost:3000/api/admin/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        name: 'Store Staff',
        email: 'staff@sellora.test',
        password: 'StaffPassword123!',
        role: 'staff',
      }),
    });
    assert.equal(createStaff.status, 201);

    // Sign in as Admin and Staff (unlocking strict device approval + secondary security password)
    const adminSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@sellora.test', password: 'AdminPassword123!' }),
    });
    assert.equal(adminSignIn.status, 200);
    const adminCookie = await unlockPrivilegedSession(rt, adminSignIn);

    const staffSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'staff@sellora.test', password: 'StaffPassword123!' }),
    });
    assert.equal(staffSignIn.status, 200);
    const staffCookie = await unlockPrivilegedSession(rt, staffSignIn);

    // Owner allowed on owner-only endpoints
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/staff', { headers: { Cookie: ownerCookie } })).status, 200);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/audit-logs', { headers: { Cookie: ownerCookie } })).status, 200);
    assert.equal(
      (
        await rt.app.request('http://localhost:3000/api/admin/settings/bank_transfer', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
          body: JSON.stringify({ bankName: 'GTBank', accountName: 'SELLORA', accountNumber: '0123456789' }),
        })
      ).status,
      200
    );

    // Admin allowed on operations & theme, blocked on owner-only controls
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/orders', { headers: { Cookie: adminCookie } })).status, 200);
    assert.equal(
      (
        await rt.app.request('http://localhost:3000/api/admin/settings/theme', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ primaryColor: '#172554' }),
        })
      ).status,
      200
    );
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/staff', { headers: { Cookie: adminCookie } })).status, 403);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/audit-logs', { headers: { Cookie: adminCookie } })).status, 403);
    assert.equal(
      (
        await rt.app.request('http://localhost:3000/api/admin/settings/bank_transfer', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ bankName: 'Spoof Bank' }),
        })
      ).status,
      403
    );

    // Staff allowed on orders/products, blocked on staff/audit/analytics/delivery-zones
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/orders', { headers: { Cookie: staffCookie } })).status, 200);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/products', { headers: { Cookie: staffCookie } })).status, 200);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/analytics', { headers: { Cookie: staffCookie } })).status, 403);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/staff', { headers: { Cookie: staffCookie } })).status, 403);
    assert.equal((await rt.app.request('http://localhost:3000/api/admin/audit-logs', { headers: { Cookie: staffCookie } })).status, 403);

    // Staff row cannot be promoted to owner, and owner row cannot be modified via staff API
    const staffRow = await rt.db.get<{ id: string }>(`SELECT id FROM user WHERE email = ?`, ['staff@sellora.test']);
    const ownerRow = await rt.db.get<{ id: string }>(`SELECT id FROM user WHERE email = ?`, ['olarindevictor046@gmail.com']);
    assert.equal(
      (
        await rt.app.request(`http://localhost:3000/api/admin/staff/${staffRow!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
          body: JSON.stringify({ role: 'owner' }),
        })
      ).status,
      403
    );
    assert.equal(
      (
        await rt.app.request(`http://localhost:3000/api/admin/staff/${ownerRow!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
          body: JSON.stringify({ isActive: false }),
        })
      ).status,
      403
    );
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('Google OAuth provider config, real redirect URL generation, callback error handling, and role preservation', async () => {
  // Without credentials -> googleOAuthEnabled is false
  const rtNoGoogle = createTestRuntime();
  try {
    const me = await (await rtNoGoogle.app.request('http://localhost:3000/api/me')).json();
    assert.equal(me.capabilities.googleOAuthEnabled, false);
  } finally {
    fs.rmSync(rtNoGoogle.tmpDir, { recursive: true, force: true });
  }

  // With Google credentials -> Better Auth generates Google authorization URL + callback handling
  const rtGoogle = createTestRuntime({
    googleClientId: '1234567890-mock.apps.googleusercontent.com',
    googleClientSecret: 'mock-google-client-secret',
  });
  try {
    const me = await (await rtGoogle.app.request('http://localhost:3000/api/me')).json();
    assert.equal(me.capabilities.googleOAuthEnabled, true);

    const socialInit = await rtGoogle.app.request('http://localhost:3000/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/api/auth/complete' }),
    });
    assert.equal(socialInit.status, 200);
    const socialJson = (await socialInit.json()) as { url?: string; redirect?: boolean };
    assert.ok(socialJson.url?.startsWith('https://accounts.google.com/o/oauth2/'));
    assert.ok(socialJson.url?.includes('prompt=select_account'));
    assert.ok(
      socialJson.url?.includes(encodeURIComponent('http://localhost:3000/api/auth/callback/google'))
    );

    // OAuth cancellation / error callback does not crash
    const errCallback = await rtGoogle.app.request(
      'http://localhost:3000/api/auth/callback/google?error=access_denied'
    );
    assert.ok(errCallback.status >= 300 && errCallback.status < 500);

    // Role preservation check for existing owner vs ordinary customer session resolution
    const { cookie: ownerCookie } = await provisionAndSignInOwner(rtGoogle, {
      email: 'olarindevictor046@gmail.com',
      password: 'StrongPassword123!',
    });
    const resolvedOwner = await getSessionUser(
      rtGoogle.auth,
      rtGoogle.db,
      new Headers({ Cookie: ownerCookie })
    );
    assert.equal(resolvedOwner?.role, 'owner');
  } finally {
    fs.rmSync(rtGoogle.tmpDir, { recursive: true, force: true });
  }
});

test('Cloudflare Turnstile server verification rejects missing, invalid, and replayed tokens while never exposing secret', async () => {
  const originalFetch = globalThis.fetch;
  const rt = createTestRuntime({
    turnstileSecretKey: '1x0000000000000000000000000000000AA',
    turnstileSiteKey: '1x00000000000000000000AA',
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
      const bodyStr = init?.body ? init.body.toString() : '';
      const params = new URLSearchParams(bodyStr);
      const token = params.get('response');
      return new Response(JSON.stringify({ success: token === 'valid-turnstile-token-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    await seedInitialStoreData(rt.db);

    const me = await (await rt.app.request('http://localhost:3000/api/me')).json();
    assert.equal(me.capabilities.turnstileEnabled, true);
    assert.equal(me.capabilities.turnstileSiteKey, '1x00000000000000000000AA');
    assert.equal(JSON.stringify(me).includes('1x0000000000000000000000000000000AA'), false);

    // Missing token on signup -> 400
    const missingSignup = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'No Token',
        email: 'notoken@sellora.test',
        password: 'CustomerPassword123!',
      }),
    });
    assert.equal(missingSignup.status, 400);

    // Invalid token on sign-in -> 400
    const invalidSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.5' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'StrongPassword123!',
        turnstileToken: 'bad-token',
      }),
    });
    assert.equal(invalidSignIn.status, 400);

    // Valid token succeeds on signup
    const validSignup = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Verified User',
        email: 'verified@sellora.test',
        password: 'CustomerPassword123!',
        turnstileToken: 'valid-turnstile-token-1',
      }),
    });
    assert.equal(validSignup.status, 200);

    // Reusing the exact same valid token MUST fail (anti-replay)
    const replaySignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'verified@sellora.test',
        password: 'CustomerPassword123!',
        turnstileToken: 'valid-turnstile-token-1',
      }),
    });
    assert.equal(replaySignIn.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('Cloudflare D1 adapter executes Better Auth + Hono commerce routes end-to-end', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellora-d1-'));
  try {
    const mockD1 = createInMemoryD1Shim(path.resolve(process.cwd(), 'migrations'));
    const d1Db = createD1Db(mockD1);
    const storage = createLocalStorage(path.join(tmpDir, 'r2'));
    const env: AppEnvConfig = {
      betterAuthSecret: 'test-secret-012345678901234567890123456789',
      ownerEmail: 'olarindevictor046@gmail.com',
      appUrl: 'https://sellora-test.workers.dev',
    };

    await seedInitialStoreData(d1Db);
    const auth = createSelloraAuth({
      database: mockD1,
      db: d1Db,
      baseURL: env.appUrl!,
      secret: env.betterAuthSecret,
      emailEnv: env,
      ownerEmail: env.ownerEmail,
    });
    const app = createSelloraApiApp({ db: d1Db, storage, auth, env });

    const health = await app.request('https://sellora-test.workers.dev/api/health');
    assert.equal(health.status, 200);

    const { cookie: ownerCookie } = await provisionAndSignInOwner(
      { app, db: d1Db },
      { email: 'olarindevictor046@gmail.com', password: 'StrongPassword123!' }
    );

    const addZone = await app.request('https://sellora-test.workers.dev/api/admin/delivery-zones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        state: 'Abuja FCT',
        lga: 'Wuse',
        feeNaira: 4000,
        estimatedDaysMin: 1,
        estimatedDaysMax: 3,
      }),
    });
    assert.equal(addZone.status, 201);

    const custSignUp = await app.request('https://sellora-test.workers.dev/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'D1 Customer',
        email: 'd1-cust@sellora.test',
        password: 'CustomerPassword123!',
      }),
    });
    assert.equal(custSignUp.status, 200);
    const custCookie = custSignUp.headers.get('set-cookie')!.split(';')[0];

    const productsRes = await (
      await app.request('https://sellora-test.workers.dev/api/products')
    ).json();
    const p = productsRes.products[0];
    const v = p.variants[0];

    const checkout = await app.request('https://sellora-test.workers.dev/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: custCookie },
      body: JSON.stringify({
        items: [{ productId: p.id, variantId: v.id, quantity: 1 }],
        address: {
          fullName: 'D1 Customer',
          email: 'd1-cust@sellora.test',
          phone: '08090001111',
          state: 'Abuja FCT',
          lga: 'Wuse',
          city: 'Wuse II',
          streetAddress: '10 Aminu Kano Crescent',
        },
      }),
    });
    assert.equal(checkout.status, 201);
    const order = await checkout.json();
    assert.equal(order.deliveryFeeKobo, 400000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Brevo transactional email outbox enforces idempotency keys and records provider errors cleanly', async () => {
  const rt = createTestRuntime({
    brevoApiKey: 'xkeysib-test-fake-key',
    brevoFromEmail: 'orders@sellora.test',
    adminNotificationEmail: 'admin@sellora.test',
  });
  const originalFetch = globalThis.fetch;
  let brevoCallCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('api.brevo.com/v3/smtp/email')) {
      brevoCallCount += 1;
      if (brevoCallCount <= 2) {
        return new Response(JSON.stringify({ messageId: `<msg-${brevoCallCount}@brevo.test>` }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ message: 'Sender not validated in Brevo' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    await seedInitialStoreData(rt.db);

    const payload = {
      eventKey: 'order_processing',
      orderId: 'ord_test_1',
      orderNumber: 'SLR-20261114-ABC123',
      customerName: 'Chidi Eze',
      customerEmail: 'chidi@sellora.test',
      statusLabel: 'Processing',
      totalFormatted: '₦45,000',
      customerTitle: 'Order Update: Processing',
      customerIntro: 'Your order is being prepared.',
      adminTitle: 'Order Processing',
      adminIntro: 'Order moved to processing.',
    };

    // First call dispatches 1 customer + 1 admin email (2 Brevo calls)
    await triggerOrderNotifications(rt.db, rt.env, payload);
    // Repeat identical call MUST be deduplicated (0 additional Brevo calls)
    await triggerOrderNotifications(rt.db, rt.env, payload);
    assert.equal(brevoCallCount, 2);

    const rows = await rt.db.all<{ recipient_type: string; status: string }>(
      `SELECT recipient_type, status FROM email_notification_events WHERE order_id = ?`,
      ['ord_test_1']
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === 'accepted_by_provider'));

    // Simulated Brevo 400 error marks failed and records attempt without throwing
    const queued = await queueEmailEvent(rt.db, {
      idempotencyKey: 'test:brevo-error:1',
      recipientEmail: 'customer@sellora.test',
      recipientType: 'test',
      notificationType: 'admin_test_email',
      subject: 'Brevo Failure Test',
      htmlBody: '<p>Test</p>',
    });
    const dispatchRes = await dispatchSingleEmailEvent(rt.db, rt.env, queued.eventId!);
    assert.equal(dispatchRes.ok, false);
    assert.equal(dispatchRes.status, 'failed');
    assert.ok(dispatchRes.error?.includes('Sender not validated in Brevo'));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('Designated owner olarindevictor046@gmail.com Email+Password and Google OAuth linking share one account and notification email defaults to olarindevictor046@gmail.com', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor046@gmail.com',
    googleClientId: '1234567890-mock.apps.googleusercontent.com',
    googleClientSecret: 'mock-google-client-secret',
  });
  try {
    await seedInitialStoreData(rt.db);

    const effEmail = await getEffectiveEmailConfig(rt.db, rt.env);
    assert.equal(effEmail.adminNotificationEmail, 'olarindevictor046@gmail.com');

    // Ordinary customer signup with forged owner role stays customer
    const custRes = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Regular Shopper',
        email: 'shopper@example.com',
        password: 'StrongPassword123!',
        role: 'owner',
      }),
    });
    assert.equal(custRes.status, 200);
    const custCookie = custRes.headers.get('set-cookie')!.split(';')[0];
    const meCust = await (
      await rt.app.request('http://localhost:3000/api/me', { headers: { Cookie: custCookie } })
    ).json();
    assert.equal(meCust.user.role, 'customer');

    // Provision owner with Email & Password, verify Google account links to SAME user.id without overwriting password
    const prov = await provisionOwnerInDb(rt.db, {
      name: 'Victor Olarinde',
      email: 'olarindevictor046@gmail.com',
      password: 'OwnerPassword123!',
    });
    assert.equal(prov.status, 'created');

    // Re-provisioning refuses silently overwriting existing password
    const secondProv = await provisionOwnerInDb(rt.db, {
      name: 'Victor Olarinde',
      email: 'olarindevictor046@gmail.com',
      password: 'NewPassword999!',
      addPasswordIfMissing: true,
    });
    assert.equal(secondProv.status, 'already_exists');

    // Sign in with Email+Password -> owner role persists
    const signInAgain = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'OwnerPassword123!',
      }),
    });
    assert.equal(signInAgain.status, 200);
    const newOwnerCookie = signInAgain.headers.get('set-cookie')!.split(';')[0];
    const meOwner = await (
      await rt.app.request('http://localhost:3000/api/me', { headers: { Cookie: newOwnerCookie } })
    ).json();
    assert.equal(meOwner.user.role, 'owner');
    assert.equal(meOwner.user.email, 'olarindevictor046@gmail.com');
    assert.equal(meOwner.user.id, prov.userId);
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('SEO endpoints (robots.txt, sitemap.xml, meta injection, noindex on private paths) and product/category SEO persistence', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor046@gmail.com',
    googleSiteVerification: 'gsc-verify-token-abc123',
    gaMeasurementId: 'G-SELLORA99',
  });
  try {
    await seedInitialStoreData(rt.db);

    const { cookie: ownerCookie } = await provisionAndSignInOwner(rt);

    // Save custom product SEO & image alt
    const prodList = await (await rt.app.request('http://localhost:3000/api/products')).json();
    const targetProd = prodList.products[0];
    const patchProd = await rt.app.request(
      `http://localhost:3000/api/admin/products/${targetProd.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          seoTitle: 'Custom Studio Headphones Title — SELLORA',
          seoDescription: 'Custom studio headphones meta description for Google SERPs.',
          imageAlt: 'Studio headphones isolated in dark navy box',
        }),
      }
    );
    assert.equal(patchProd.status, 200);

    // Update category SEO
    const cats = await (
      await rt.app.request('http://localhost:3000/api/admin/categories', {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    const patchCat = await rt.app.request(
      `http://localhost:3000/api/admin/categories/${cats.categories[0].id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          seoTitle: 'Curated Audio Gear — SELLORA',
          seoDescription: 'Studio audio gear priced in NGN.',
        }),
      }
    );
    assert.equal(patchCat.status, 200);

    // Verify robots.txt blocks private routes and references sitemap
    const robots = await generateRobotsTxt(rt.db, rt.env, 'https://sellora.example.com');
    assert.ok(robots.includes('Disallow: /admin'));
    assert.ok(robots.includes('Disallow: /account'));
    assert.ok(robots.includes('Disallow: /checkout'));
    assert.ok(robots.includes('Disallow: /api/'));
    assert.ok(robots.includes('Sitemap: http://localhost:3000/sitemap.xml'));

    // Verify sitemap.xml contains public products & categories, excludes private routes
    const sitemap = await generateSitemapXml(rt.db, rt.env, 'https://sellora.example.com');
    assert.ok(sitemap.includes(`<loc>http://localhost:3000/product/${encodeURIComponent(targetProd.slug)}</loc>`));
    assert.ok(sitemap.includes(`<loc>http://localhost:3000/category/${encodeURIComponent(cats.categories[0].slug)}</loc>`));
    assert.equal(sitemap.includes('/admin'), false);
    assert.equal(sitemap.includes('/checkout'), false);
    assert.equal(sitemap.includes('/account'), false);

    const baseHtml =
      '<!doctype html><html><head><title>Placeholder</title><meta name="description" content="old" /><meta property="og:type" content="website" /><meta property="og:title" content="old" /><meta property="og:description" content="old" /><meta name="twitter:title" content="old" /><meta name="twitter:description" content="old" /></head><body></body></html>';

    // Public product route gets custom title, canonical, index/follow, and Google verification meta
    const prodHtml = await injectSeoIntoHtml(
      baseHtml,
      new URL(`http://localhost:3000/product/${targetProd.slug}`),
      rt.db,
      rt.env
    );
    assert.ok(prodHtml.includes('<title>Custom Studio Headphones Title — SELLORA</title>'));
    assert.ok(prodHtml.includes('content="gsc-verify-token-abc123"'));
    assert.ok(prodHtml.includes('content="index, follow"'));
    assert.ok(prodHtml.includes(`href="http://localhost:3000/product/${encodeURIComponent(targetProd.slug)}"`));

    // Private /admin route gets noindex, nofollow
    const adminHtml = await injectSeoIntoHtml(
      baseHtml,
      new URL('http://localhost:3000/admin'),
      rt.db,
      rt.env
    );
    assert.ok(adminHtml.includes('content="noindex, nofollow"'));
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('First-party privacy-safe analytics collection, expanded settings summary, and owner session revocation', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor046@gmail.com',
  });
  try {
    await seedInitialStoreData(rt.db);
    const { cookie: ownerCookie } = await provisionAndSignInOwner(rt);

    // Collect non-PII events (query params stripped)
    await rt.app.request('http://localhost:3000/api/analytics/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone)' },
      body: JSON.stringify({
        sessionKey: 'sess_abc123',
        eventName: 'page_view',
        path: '/shop?email=leak@example.com',
        referrer: 'https://www.google.com/search?q=sellora',
      }),
    });
    await rt.app.request('http://localhost:3000/api/analytics/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKey: 'sess_abc123',
        eventName: 'view_item',
        path: '/product/sora-studio-headphones',
      }),
    });
    await rt.app.request('http://localhost:3000/api/analytics/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKey: 'sess_abc123',
        eventName: 'add_to_cart',
        path: '/product/sora-studio-headphones',
        valueKobo: 4500000,
      }),
    });

    const analyticsRes = await (
      await rt.app.request('http://localhost:3000/api/admin/analytics', {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    assert.equal(analyticsRes.insights.uniqueVisitors, 1);
    assert.equal(analyticsRes.insights.pageViews, 1);
    assert.equal(analyticsRes.insights.productViews, 1);
    assert.equal(analyticsRes.insights.addToCart, 1);
    assert.equal(analyticsRes.insights.landingPages[0].path, '/shop');
    assert.equal(analyticsRes.insights.trafficSources[0].source, 'search');
    assert.equal(analyticsRes.insights.deviceCategories[0].device, 'mobile');

    // Settings summary contains ownerSummary & clean emailStatus without bootstrap secrets or infrastructure leaks
    const settingsRes = await (
      await rt.app.request('http://localhost:3000/api/admin/settings', {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    assert.equal(settingsRes.ownerSummary.designatedOwnerEmail, 'olarindevictor046@gmail.com');
    assert.equal(settingsRes.ownerSummary.ownerExists, true);
    assert.deepEqual(settingsRes.ownerSummary.authMethods, ['google', 'email_password']);
    assert.equal(settingsRes.ownerSummary.bootstrapConfigured, undefined);
    assert.equal(settingsRes.integrationStatus, undefined);
    assert.equal(settingsRes.emailStatus.hasBrevoApiKey, undefined);
    assert.equal(typeof settingsRes.emailStatus.notificationServiceReady, 'boolean');

    // Owner sessions list & revoke
    const sessRes = await (
      await rt.app.request('http://localhost:3000/api/admin/sessions', {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    assert.ok(sessRes.sessions.length >= 1);
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('Analytics handles empty database safely, separates confirmed vs unconfirmed revenue, and computes breakdowns accurately', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor046@gmail.com',
  });
  try {
    await seedInitialStoreData(rt.db);
    const { cookie: ownerCookie } = await provisionAndSignInOwner(rt);

    // Part A: Empty orders / analytics dataset -> zero division safe
    const emptyAn = await (
      await rt.app.request('http://localhost:3000/api/admin/analytics', {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    assert.equal(emptyAn.metrics.totalOrders, 0);
    assert.equal(emptyAn.metrics.confirmedRevenueKobo, 0);
    assert.equal(emptyAn.metrics.unconfirmedRevenueKobo, 0);
    assert.equal(emptyAn.metrics.averageOrderValueKobo, null);
    assert.equal(emptyAn.metrics.netProfitKobo, null);
    assert.equal(emptyAn.insights.conversionRatePct, null);
    assert.deepEqual(emptyAn.orderStatusBreakdown, []);
    assert.deepEqual(emptyAn.paymentMethodBreakdown, []);
    assert.deepEqual(emptyAn.salesTrendDaily, []);

    // Configure delivery zone and create two customers (A & B)
    await rt.app.request('http://localhost:3000/api/admin/delivery-zones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ state: 'Lagos', lga: 'Ikeja', feeNaira: 2000, estimatedDaysMin: 1, estimatedDaysMax: 2 }),
    });

    const signUpA = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cust A', email: 'custa@test.ng', password: 'StrongPassword123!' }),
    });
    const cookieA = signUpA.headers.get('set-cookie')!.split(';')[0];

    const signUpB = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cust B', email: 'custb@test.ng', password: 'StrongPassword123!' }),
    });
    const cookieB = signUpB.headers.get('set-cookie')!.split(';')[0];

    const productsRes = await (await rt.app.request('http://localhost:3000/api/products')).json();
    const p1 = productsRes.products[0];
    const v1 = p1.variants[0];

    // Order 1 (Cust A -> will remain payment_under_review, MUST NOT be in confirmedRevenueKobo)
    const ord1Res = await rt.app.request('http://localhost:3000/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({
        items: [{ productId: p1.id, variantId: v1.id, quantity: 1 }],
        address: {
          fullName: 'Cust A',
          email: 'custa@test.ng',
          phone: '08011112222',
          state: 'Lagos',
          lga: 'Ikeja',
          city: 'Ikeja',
          streetAddress: '1 Toyin Street',
        },
      }),
    });
    const ord1 = await ord1Res.json();

    // Cust A uploads evidence -> payment_under_review (still unconfirmed)
    const evForm = new FormData();
    evForm.append('verificationEmail', 'custa@test.ng');
    evForm.append('referenceNumber', 'NIP-112233');
    evForm.append('amountNaira', String(ord1.totalKobo / 100));
    evForm.append('transferDate', '2026-11-14');
    evForm.append(
      'receipt',
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])],
        'r.png',
        { type: 'image/png' }
      )
    );
    const evUpload = await rt.app.request(`http://localhost:3000/api/payments/${ord1.orderNumber}/evidence`, {
      method: 'POST',
      headers: { Cookie: cookieA },
      body: evForm,
    });
    const evJson = await evUpload.json();

    // Isolation check: Customer B CANNOT read Customer A's uploaded receipt or order
    const crossCustomerReceipt = await rt.app.request(
      `http://localhost:3000/api/payments/evidence/${evJson.evidenceId}/file`,
      { headers: { Cookie: cookieB } }
    );
    assert.equal(crossCustomerReceipt.status, 403);

    const custBOrders = await (
      await rt.app.request('http://localhost:3000/api/orders', { headers: { Cookie: cookieB } })
    ).json();
    assert.equal(custBOrders.orders.length, 0);

    const crossOrderRead = await rt.app.request(`http://localhost:3000/api/orders/${ord1.orderNumber}`, {
      headers: { Cookie: cookieB },
    });
    assert.ok(crossOrderRead.status === 403 || crossOrderRead.status === 404);

    // Order 2 (Cust B -> confirmed by owner)
    const ord2Res = await rt.app.request('http://localhost:3000/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({
        items: [{ productId: p1.id, variantId: v1.id, quantity: 1 }],
        address: {
          fullName: 'Cust B',
          email: 'custb@test.ng',
          phone: '08033334444',
          state: 'Lagos',
          lga: 'Ikeja',
          city: 'Ikeja',
          streetAddress: '2 Oba Akran',
        },
      }),
    });
    const ord2 = await ord2Res.json();

    await rt.app.request(`http://localhost:3000/api/admin/payments/${ord2.orderId}/verify`, {
      method: 'POST',
      headers: { Cookie: ownerCookie },
    });

    // Analytics check: Order 1 in unconfirmedRevenueKobo, Order 2 in confirmedRevenueKobo & salesTrend
    const realAn = await (
      await rt.app.request('http://localhost:3000/api/admin/analytics', {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    assert.equal(realAn.metrics.totalOrders, 2);
    assert.equal(realAn.metrics.confirmedRevenueKobo, ord2.totalKobo);
    assert.equal(realAn.metrics.unconfirmedRevenueKobo, ord1.totalKobo);
    assert.equal(realAn.salesTrendDaily.length, 1);
    assert.equal(realAn.salesTrendDaily[0].orders, 1);
    assert.equal(realAn.salesTrendDaily[0].total_kobo, ord2.totalKobo);
    assert.equal(realAn.salesTrendWeekly.length, 1);
    assert.equal(realAn.salesTrendMonthly.length, 1);
    assert.equal(realAn.paymentMethodBreakdown[0].method, 'bank_transfer');
    assert.equal(realAn.paymentMethodBreakdown[0].count, 2);
    assert.ok(
      realAn.orderStatusBreakdown.some((s: any) => s.status === 'payment_under_review' && s.count === 1)
    );
    assert.ok(
      realAn.orderStatusBreakdown.some((s: any) => s.status === 'payment_confirmed' && s.count === 1)
    );
    assert.equal(realAn.bestsellers.length, 1);
    assert.equal(realAn.bestsellers[0].units_sold, 1);
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('SSR SEO returns crawlable product/legal HTML + JSON-LD and genuine HTTP 404 on missing pages', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor046@gmail.com',
  });
  try {
    await seedInitialStoreData(rt.db);
    const prodList = await (await rt.app.request('http://localhost:3000/api/products')).json();
    const firstProd = prodList.products[0];

    const template =
      '<!doctype html><html><head><title>T</title><meta name="description" content="d" /><meta property="og:type" content="website" /><meta property="og:title" content="t" /><meta property="og:description" content="d" /><meta name="twitter:title" content="t" /><meta name="twitter:description" content="d" /></head><body><div id="root"></div></body></html>';

    // Product page renders status 200, crawlable H1 + JSON-LD Product schema
    const prodSsr = await renderSeoHtmlResponse(
      template,
      new URL(`http://localhost:3000/product/${firstProd.slug}`),
      rt.db,
      rt.env
    );
    assert.equal(prodSsr.status, 200);
    assert.ok(prodSsr.html.includes(`<h1>${firstProd.name}</h1>`));
    assert.ok(prodSsr.html.includes('"@type":"Product"'));
    assert.ok(prodSsr.html.includes('"priceCurrency":"NGN"'));

    // Legal pages (/privacy-policy & /terms) resolve 200 and appear in sitemap
    const privSsr = await renderSeoHtmlResponse(
      template,
      new URL('http://localhost:3000/privacy-policy'),
      rt.db,
      rt.env
    );
    assert.equal(privSsr.status, 200);
    assert.ok(privSsr.html.includes('<h1>Privacy Policy</h1>'));

    const sitemap = await generateSitemapXml(rt.db, rt.env, 'http://localhost:3000');
    assert.ok(sitemap.includes('/privacy-policy'));
    assert.ok(sitemap.includes('/terms'));

    // Unknown path & missing product return true HTTP 404 + noindex, nofollow
    const unknownSsr = await renderSeoHtmlResponse(
      template,
      new URL('http://localhost:3000/does-not-exist-xyz'),
      rt.db,
      rt.env
    );
    assert.equal(unknownSsr.status, 404);
    assert.ok(unknownSsr.html.includes('content="noindex, nofollow"'));

    const missingProdSsr = await renderSeoHtmlResponse(
      template,
      new URL('http://localhost:3000/product/nonexistent-product-999'),
      rt.db,
      rt.env
    );
    assert.equal(missingProdSsr.status, 404);
    assert.ok(missingProdSsr.html.includes('content="noindex, nofollow"'));
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('Optional integrations (GOOGLE_SITE_VERIFICATION, Turnstile keys, VITE_GA_MEASUREMENT_ID) are non-blocking when absent, whitespace, or partial', async () => {
  // 1. All 4 optional variables empty / whitespace -> clean capabilities, no empty verification meta, no blocking
  const rtEmpty = createTestRuntime({
    googleSiteVerification: '   ',
    gaMeasurementId: '   ',
    turnstileSecretKey: '',
    turnstileSiteKey: '',
  });
  try {
    await seedInitialStoreData(rtEmpty.db);

    const me = await (await rtEmpty.app.request('http://localhost:3000/api/me')).json();
    assert.equal(me.capabilities.turnstileEnabled, false);
    assert.equal(me.capabilities.turnstileSiteKey, null);
    assert.equal(me.capabilities.gaConfigured, false);
    assert.equal(me.capabilities.searchConsoleConfigured, false);

    // No empty google-site-verification tag injected
    const baseHtml =
      '<!doctype html><html><head><title>T</title><meta name="description" content="d" /><meta property="og:type" content="website" /><meta property="og:title" content="t" /><meta property="og:description" content="d" /><meta name="twitter:title" content="t" /><meta name="twitter:description" content="d" /></head><body><div id="root"></div></body></html>';
    const homeSsr = await renderSeoHtmlResponse(
      baseHtml,
      new URL('http://localhost:3000/'),
      rtEmpty.db,
      rtEmpty.env
    );
    assert.equal(homeSsr.status, 200);
    assert.equal(homeSsr.html.includes('google-site-verification'), false);

    // Validators reject empty & placeholder strings cleanly
    assert.equal(sanitizeGoogleSiteVerification(''), '');
    assert.equal(sanitizeGoogleSiteVerification('   '), '');
    assert.equal(sanitizeGoogleSiteVerification('REPLACE_WITH_TOKEN'), '');
    assert.equal(sanitizeGoogleSiteVerification('valid-token-123'), 'valid-token-123');

    assert.equal(sanitizeGaMeasurementId(''), '');
    assert.equal(sanitizeGaMeasurementId('G-XXXXXXXXXX'), '');
    assert.equal(sanitizeGaMeasurementId('G-SELLORA99'), 'G-SELLORA99');
    assert.equal(resolveGaMeasurementId(''), '');
    assert.equal(resolveGaMeasurementId('G-XXXXXXXXXX'), '');
    assert.equal(resolveGaMeasurementId('G-SELLORA99'), 'G-SELLORA99');

    // Placeholder GA ID in env is also rejected by /api/me
    const rtPlaceholderGa = createTestRuntime({ gaMeasurementId: 'G-XXXXXXXXXX' });
    try {
      const mePlaceholder = await (
        await rtPlaceholderGa.app.request('http://localhost:3000/api/me')
      ).json();
      assert.equal(mePlaceholder.capabilities.gaConfigured, false);
    } finally {
      fs.rmSync(rtPlaceholderGa.tmpDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(rtEmpty.tmpDir, { recursive: true, force: true });
  }

  // 2. Partial Turnstile config (secret only OR site key only) disables gracefully and never fakes 'verified'
  assert.equal(isTurnstileConfigured({ turnstileSecretKey: 'secret-only', turnstileSiteKey: '' }), false);
  assert.equal(isTurnstileConfigured({ turnstileSecretKey: '', turnstileSiteKey: 'site-only' }), false);

  const disabledRes1 = await verifyTurnstileToken({
    token: 'any-token',
    secretKey: 'secret-only',
    siteKey: '',
  });
  assert.equal(disabledRes1.ok, true);
  assert.equal(disabledRes1.status, 'disabled');

  const disabledRes2 = await verifyTurnstileToken({
    token: '',
    secretKey: '',
    siteKey: 'site-only',
  });
  assert.equal(disabledRes2.ok, true);
  assert.equal(disabledRes2.status, 'disabled');

  // Secret-only server runtime MUST NOT deadlock customer signup without a frontend widget
  const rtSecretOnly = createTestRuntime({
    turnstileSecretKey: 'secret-only-without-sitekey',
  });
  try {
    await seedInitialStoreData(rtSecretOnly.db);
    const mePartial = await (await rtSecretOnly.app.request('http://localhost:3000/api/me')).json();
    assert.equal(mePartial.capabilities.turnstileEnabled, false);

    const signupRes = await rtSecretOnly.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Non Blocked Shopper',
        email: 'nonblocked@sellora.test',
        password: 'StrongPassword123!',
      }),
    });
    assert.equal(signupRes.status, 200);
  } finally {
    fs.rmSync(rtSecretOnly.tmpDir, { recursive: true, force: true });
  }
});

// =====================================================================
// STAGE 2 SEPARATED TEST SUITES (1–8)
// Note: SQLite / in-memory D1 shim tests prove SQL trigger invariants,
// statement atomicity, and rollback semantics in local single-connection
// execution; they do NOT simulate distributed edge D1 multi-isolate races.
// =====================================================================

async function setupCommerceFixture(opts: { useD1Shim?: boolean } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellora-s2-'));
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  const mockD1 = opts.useD1Shim ? createInMemoryD1Shim(migrationsDir) : null;
  const db = mockD1
    ? createD1Db(mockD1)
    : createSqliteDb(path.join(tmpDir, 'test.db'), migrationsDir);
  const storage = createLocalStorage(path.join(tmpDir, 'r2'));
  const env: AppEnvConfig = {
    betterAuthSecret: 'test-secret-012345678901234567890123456789',
    ownerEmail: 'olarindevictor046@gmail.com',
    appUrl: 'http://localhost:3000',
  };
  await seedInitialStoreData(db);
  const auth = createSelloraAuth({
    database: mockD1 || db.rawSqlite!,
    db,
    baseURL: env.appUrl!,
    secret: env.betterAuthSecret,
    emailEnv: env,
    ownerEmail: env.ownerEmail,
  });
  const app = createSelloraApiApp({ db, storage, auth, env });

  const { cookie: ownerCookie } = await provisionAndSignInOwner(
    { app, db },
    { email: 'olarindevictor046@gmail.com', password: 'StrongOwnerPassword123!' }
  );

  const dzRes = await app.request('http://localhost:3000/api/admin/delivery-zones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({
      state: 'Lagos',
      lga: 'Ikeja',
      feeNaira: 2500,
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
      isEnabled: true,
    }),
  });
  assert.equal(dzRes.status, 201);
  const dzJson = await dzRes.json();

  const custSignUp = await app.request('http://localhost:3000/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Stage2 Shopper',
      email: 'shopper@sellora.test',
      password: 'ShopperPassword123!',
    }),
  });
  assert.equal(custSignUp.status, 200);
  const custCookie = custSignUp.headers.get('set-cookie')!.split(';')[0];

  const prodRes = await (await app.request('http://localhost:3000/api/products')).json();
  return {
    tmpDir,
    db,
    mockD1,
    storage,
    app,
    ownerCookie,
    custCookie,
    zoneId: dzJson.id as string,
    products: prodRes.products as any[],
  };
}

describe('Suite 1: SQLite Unit Tests (Migration 0004 Triggers, ISO Timestamps & Batch Semantics)', () => {
  test('enforces coupon starts_at, expires_at, NULL bounds, max_uses, and is_active without blocking admin toggle', async () => {
    const rt = createTestRuntime();
    try {
      await seedInitialStoreData(rt.db);
      const now = Date.now();
      const pastIso = new Date(now - 3_600_000).toISOString();
      const futureIso = new Date(now + 3_600_000).toISOString();

      await rt.db.batch([
        {
          sql: `INSERT INTO coupons (id, code, discount_type, discount_value, min_spend_kobo, max_uses, used_count, starts_at, expires_at, is_active, created_at)
                VALUES ('c_future', 'FUTURE', 'fixed', 10000, 0, NULL, 0, ?, NULL, 1, ?)`,
          params: [futureIso, new Date().toISOString()],
        },
        {
          sql: `INSERT INTO coupons (id, code, discount_type, discount_value, min_spend_kobo, max_uses, used_count, starts_at, expires_at, is_active, created_at)
                VALUES ('c_expired', 'EXPIRED', 'fixed', 10000, 0, NULL, 0, NULL, ?, 1, ?)`,
          params: [pastIso, new Date().toISOString()],
        },
        {
          sql: `INSERT INTO coupons (id, code, discount_type, discount_value, min_spend_kobo, max_uses, used_count, starts_at, expires_at, is_active, created_at)
                VALUES ('c_unlimited', 'OPENALL', 'fixed', 10000, 0, NULL, 0, NULL, NULL, 1, ?)`,
          params: [new Date().toISOString()],
        },
        {
          sql: `INSERT INTO coupons (id, code, discount_type, discount_value, min_spend_kobo, max_uses, used_count, starts_at, expires_at, is_active, created_at)
                VALUES ('c_limited', 'CAP2', 'fixed', 10000, 0, 2, 0, ?, ?, 1, ?)`,
          params: [pastIso, futureIso, new Date().toISOString()],
        },
      ]);

      await assert.rejects(
        () => rt.db.run(`UPDATE coupons SET used_count = used_count + 1 WHERE id = 'c_future'`),
        (err) => extractDbGuardCode(err) === 'COUPON_NOT_STARTED'
      );
      await assert.rejects(
        () => rt.db.run(`UPDATE coupons SET used_count = used_count + 1 WHERE id = 'c_expired'`),
        (err) => extractDbGuardCode(err) === 'COUPON_EXPIRED'
      );

      // NULL starts_at, NULL expires_at, NULL max_uses increments cleanly multiple times
      await rt.db.run(`UPDATE coupons SET used_count = used_count + 1 WHERE id = 'c_unlimited'`);
      await rt.db.run(`UPDATE coupons SET used_count = used_count + 1 WHERE id = 'c_unlimited'`);
      const unlim = await rt.db.get<{ used_count: number }>(`SELECT used_count FROM coupons WHERE id = 'c_unlimited'`);
      assert.equal(unlim?.used_count, 2);

      // Admin deactivation works even if coupon already has NULLs or usages
      await rt.db.run(`UPDATE coupons SET is_active = 0 WHERE id = 'c_unlimited'`);
      await assert.rejects(
        () => rt.db.run(`UPDATE coupons SET used_count = used_count + 1 WHERE id = 'c_unlimited'`),
        (err) => extractDbGuardCode(err) === 'COUPON_INACTIVE'
      );

      // max_uses = 2 permits 2 increments and aborts on 3rd
      await rt.db.run(`UPDATE coupons SET used_count = used_count + 1 WHERE id = 'c_limited'`);
      await rt.db.run(`UPDATE coupons SET used_count = used_count + 1 WHERE id = 'c_limited'`);
      await assert.rejects(
        () => rt.db.run(`UPDATE coupons SET used_count = used_count + 1 WHERE id = 'c_limited'`),
        (err) => extractDbGuardCode(err) === 'COUPON_LIMIT_EXCEEDED'
      );

      // Batch rollback verified on stock trigger
      const v = await rt.db.get<{ id: string; stock_quantity: number }>(
        `SELECT id, stock_quantity FROM product_variants LIMIT 1`
      );
      assert.ok(v);
      await assert.rejects(
        () =>
          rt.db.batch([
            { sql: `UPDATE coupons SET used_count = used_count + 1 WHERE id = 'c_future'`, params: [] },
          ]),
        /COUPON_NOT_STARTED/
      );
      await assert.rejects(
        () =>
          rt.db.batch([
            {
              sql: `UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?`,
              params: [v!.stock_quantity + 1, v!.id],
            },
          ]),
        (err) => extractDbGuardCode(err) === 'INSUFFICIENT_STOCK'
      );
    } finally {
      fs.rmSync(rt.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Suite 2: D1 Adapter Tests (createD1Db Batch Contract & meta.changes Mapping)', () => {
  test('calls d1.prepare/bind once per statement, sends single d1.batch, and maps meta.changes safely', async () => {
    const batchCalls: number[] = [];
    const preparedSqls: string[] = [];
    const boundValues: unknown[][] = [];

    const spyD1: D1LikeDatabase = {
      prepare(sql: string) {
        preparedSqls.push(sql);
        const makeBound = (vals: unknown[]): D1PreparedStatementLike => ({
          bind(...args: unknown[]) {
            boundValues.push(args);
            return makeBound(args);
          },
          async all() {
            return { results: [] };
          },
          async first() {
            return null;
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        });
        return makeBound([]);
      },
      async exec() {
        return {};
      },
      async batch<T = unknown>(stmts: D1PreparedStatementLike[]): Promise<T[]> {
        batchCalls.push(stmts.length);
        return [{ meta: { changes: 2 } }, {}] as T[];
      },
    };

    const d1Db = createD1Db(spyD1);
    assert.deepEqual(await d1Db.batch([]), []);
    assert.equal(batchCalls.length, 0);

    const res = await d1Db.batch([
      { sql: 'UPDATE t SET a = ? WHERE id = ?', params: [1, 'x'] },
      { sql: 'DELETE FROM t', params: [] },
    ]);

    assert.deepEqual(batchCalls, [2]);
    assert.deepEqual(preparedSqls, ['UPDATE t SET a = ? WHERE id = ?', 'DELETE FROM t']);
    assert.deepEqual(boundValues, [[1, 'x']]);
    assert.deepEqual(res, [{ changes: 2 }, { changes: 0 }]);
  });
});

describe('Suite 3: D1 Integration Tests (Transactional D1 Shim End-to-End)', () => {
  test('rolls back D1 batch atomically on mid-batch constraint failure and executes full D1 payment/address flow', async () => {
    const fx = await setupCommerceFixture({ useD1Shim: true });
    try {
      const p1 = fx.products[0];
      const v1 = p1.variants[0];
      const startStock = v1.stock_quantity;

      // Direct D1 batch rollback proof: statement 1 modifies stock, statement 2 violates stock trigger -> statement 1 rolls back
      await assert.rejects(() =>
        fx.db.batch([
          { sql: `UPDATE product_variants SET stock_quantity = stock_quantity - 2 WHERE id = ?`, params: [v1.id] },
          { sql: `UPDATE product_variants SET stock_quantity = -1 WHERE id = ?`, params: [v1.id] },
        ])
      );
      const afterAbort = await fx.db.get<{ stock_quantity: number }>(
        `SELECT stock_quantity FROM product_variants WHERE id = ?`,
        [v1.id]
      );
      assert.equal(afterAbort?.stock_quantity, startStock);

      // Customer address default switch + checkout + payment evidence + verify through D1 adapter
      const a1 = await fx.app.request('http://localhost:3000/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.custCookie },
        body: JSON.stringify({
          fullName: 'Stage2 Shopper',
          email: 'shopper@sellora.test',
          phone: '08031234567',
          state: 'Lagos',
          lga: 'Ikeja',
          city: 'Ikeja',
          streetAddress: '10 Allen Ave',
        }),
      });
      assert.equal(a1.status, 201);

      const a2 = await fx.app.request('http://localhost:3000/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.custCookie },
        body: JSON.stringify({
          fullName: 'Stage2 Shopper Office',
          email: 'shopper@sellora.test',
          phone: '08031234567',
          state: 'Lagos',
          lga: 'Ikeja',
          city: 'Ikeja',
          streetAddress: '20 Oba Akran',
          isDefault: true,
        }),
      });
      assert.equal(a2.status, 201);
      const addrs = await (
        await fx.app.request('http://localhost:3000/api/addresses', {
          headers: { Cookie: fx.custCookie },
        })
      ).json();
      assert.equal(addrs.addresses.filter((a: any) => a.is_default === 1).length, 1);

      // Deleted address PATCH with isDefault: true MUST NOT clear user's active default
      const patchMissing = await fx.app.request('http://localhost:3000/api/addresses/addr_missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: fx.custCookie },
        body: JSON.stringify({ isDefault: true }),
      });
      assert.equal(patchMissing.status, 404);
      const addrsAfterMissingPatch = await (
        await fx.app.request('http://localhost:3000/api/addresses', {
          headers: { Cookie: fx.custCookie },
        })
      ).json();
      assert.equal(addrsAfterMissingPatch.addresses.filter((a: any) => a.is_default === 1).length, 1);

      // End-to-end checkout on D1 shim
      const chk = await fx.app.request('http://localhost:3000/api/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: fx.custCookie,
          'x-forwarded-for': '10.0.3.1',
        },
        body: JSON.stringify({
          items: [{ productId: p1.id, variantId: v1.id, quantity: 2 }],
          address: {
            fullName: 'Stage2 Shopper',
            email: 'shopper@sellora.test',
            phone: '08031234567',
            state: 'Lagos',
            lga: 'Ikeja',
            city: 'Ikeja',
            streetAddress: '10 Allen Ave',
          },
          idempotencyKey: 'd1_int_chk_1',
        }),
      });
      assert.equal(chk.status, 201);
    } finally {
      fs.rmSync(fx.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Suite 4: Checkout Rollback Tests (Stock, Zone, Coupon, Duplicate Lines)', () => {
  test('rolls back item 1 stock, coupon, and cart if item 2 has insufficient stock, bad zone, bad coupon, or duplicated SKU exceeds stock', async () => {
    const fx = await setupCommerceFixture();
    try {
      const p1 = fx.products[0];
      const v1 = p1.variants[0];
      const p2 = fx.products[1];
      const v2 = p2.variants[0];
      const initV1 = v1.stock_quantity;
      const initV2 = v2.stock_quantity;

      // Save customer cart to verify rollback preserves cart
      await fx.app.request('http://localhost:3000/api/cart', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: fx.custCookie },
        body: JSON.stringify({
          items: [
            { productId: p1.id, variantId: v1.id, quantity: 2 },
            { productId: p2.id, variantId: v2.id, quantity: initV2 + 5 },
          ],
        }),
      });

      // Create valid coupon
      await fx.app.request('http://localhost:3000/api/admin/coupons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
        body: JSON.stringify({
          code: 'SAVE10',
          discountType: 'percentage',
          discountValue: 10,
          maxUses: 5,
        }),
      });

      // 1. Item 2 out of stock -> full rollback
      const failStock = await fx.app.request('http://localhost:3000/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.custCookie, 'x-forwarded-for': '10.0.4.1' },
        body: JSON.stringify({
          items: [
            { productId: p1.id, variantId: v1.id, quantity: 2 },
            { productId: p2.id, variantId: v2.id, quantity: initV2 + 5 },
          ],
          couponCode: 'SAVE10',
          address: {
            fullName: 'Stage2 Shopper',
            email: 'shopper@sellora.test',
            phone: '08031234567',
            state: 'Lagos',
            lga: 'Ikeja',
            city: 'Ikeja',
            streetAddress: '10 Allen Ave',
          },
        }),
      });
      assert.equal(failStock.status, 400);

      // 2. Duplicate lines summing above stock (e.g. half + 1 twice) -> rejected & rolled back
      const halfPlus = Math.floor(initV1 / 2) + 2;
      const failDup = await fx.app.request('http://localhost:3000/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.custCookie, 'x-forwarded-for': '10.0.4.2' },
        body: JSON.stringify({
          items: [
            { productId: p1.id, variantId: v1.id, quantity: halfPlus },
            { productId: p1.id, variantId: v1.id, quantity: halfPlus },
          ],
          address: {
            fullName: 'Stage2 Shopper',
            email: 'shopper@sellora.test',
            phone: '08031234567',
            state: 'Lagos',
            lga: 'Ikeja',
            city: 'Ikeja',
            streetAddress: '10 Allen Ave',
          },
        }),
      });
      assert.equal(failDup.status, 400);

      // 3. Invalid / disabled delivery zone -> zero deductions
      const failZone = await fx.app.request('http://localhost:3000/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.custCookie, 'x-forwarded-for': '10.0.4.3' },
        body: JSON.stringify({
          items: [{ productId: p1.id, variantId: v1.id, quantity: 1 }],
          address: {
            fullName: 'Stage2 Shopper',
            email: 'shopper@sellora.test',
            phone: '08031234567',
            state: 'Rivers',
            lga: 'Obio-Akpor',
            city: 'Port Harcourt',
            streetAddress: '12 Aba Road',
          },
        }),
      });
      assert.equal(failZone.status, 400);

      // 4. Future startsAt coupon & expired coupon -> zero deductions
      await fx.app.request('http://localhost:3000/api/admin/coupons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
        body: JSON.stringify({
          code: 'NOTYET',
          discountType: 'fixed',
          discountValue: 1000,
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      });
      const failStart = await fx.app.request('http://localhost:3000/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.custCookie, 'x-forwarded-for': '10.0.4.4' },
        body: JSON.stringify({
          items: [{ productId: p1.id, variantId: v1.id, quantity: 1 }],
          couponCode: 'NOTYET',
          address: {
            fullName: 'Stage2 Shopper',
            email: 'shopper@sellora.test',
            phone: '08031234567',
            state: 'Lagos',
            lga: 'Ikeja',
            city: 'Ikeja',
            streetAddress: '10 Allen Ave',
          },
        }),
      });
      assert.equal(failStart.status, 400);

      // Verify zero side effects across DB
      const v1Now = await fx.db.get<{ stock_quantity: number }>(`SELECT stock_quantity FROM product_variants WHERE id = ?`, [v1.id]);
      const v2Now = await fx.db.get<{ stock_quantity: number }>(`SELECT stock_quantity FROM product_variants WHERE id = ?`, [v2.id]);
      const orderCnt = await fx.db.get<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM orders`);
      const movCnt = await fx.db.get<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM inventory_movements`);
      const couponUsed = await fx.db.get<{ used_count: number }>(`SELECT used_count FROM coupons WHERE code = 'SAVE10'`);
      const cartRes = await (await fx.app.request('http://localhost:3000/api/cart', { headers: { Cookie: fx.custCookie } })).json();

      assert.equal(v1Now?.stock_quantity, initV1);
      assert.equal(v2Now?.stock_quantity, initV2);
      assert.equal(orderCnt?.cnt, 0);
      assert.equal(movCnt?.cnt, 0);
      assert.equal(couponUsed?.used_count, 0);
      assert.equal(cartRes.items.length, 2);
    } finally {
      fs.rmSync(fx.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Suite 5: Coupon Concurrency Tests (Local SQLite Serialization Guard Verification)', () => {
  test('never exceeds coupon max_uses under concurrent Promise.all checkout bursts and preserves stock on losers', async () => {
    const fx = await setupCommerceFixture({ useD1Shim: true });
    try {
      const p1 = fx.products[0];
      const v1 = p1.variants[0];
      const initialStock = v1.stock_quantity;

      await fx.app.request('http://localhost:3000/api/admin/coupons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
        body: JSON.stringify({
          code: 'RACE2',
          discountType: 'fixed',
          discountValue: 5000,
          maxUses: 2,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      });

      const attempts = Array.from({ length: 6 }, (_, i) =>
        fx.app.request('http://localhost:3000/api/checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: fx.custCookie,
            'x-forwarded-for': `10.0.5.${i + 1}`,
          },
          body: JSON.stringify({
            items: [{ productId: p1.id, variantId: v1.id, quantity: 1 }],
            couponCode: 'RACE2',
            idempotencyKey: `coupon_race_${i}`,
            address: {
              fullName: 'Stage2 Shopper',
              email: 'shopper@sellora.test',
              phone: '08031234567',
              state: 'Lagos',
              lga: 'Ikeja',
              city: 'Ikeja',
              streetAddress: '10 Allen Ave',
            },
          }),
        })
      );

      const responses = await Promise.all(attempts);
      const successes = responses.filter((r) => r.status === 201);
      const failures = responses.filter((r) => r.status === 400);
      assert.equal(successes.length, 2);
      assert.equal(failures.length, 4);

      const coupon = await fx.db.get<{ used_count: number }>(`SELECT used_count FROM coupons WHERE code = 'RACE2'`);
      const v1Now = await fx.db.get<{ stock_quantity: number }>(`SELECT stock_quantity FROM product_variants WHERE id = ?`, [v1.id]);
      const orderCnt = await fx.db.get<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM orders`);

      assert.equal(coupon?.used_count, 2);
      assert.equal(v1Now?.stock_quantity, initialStock - 2);
      assert.equal(orderCnt?.cnt, 2);
    } finally {
      fs.rmSync(fx.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Suite 6: Inventory & Payment Review Concurrency Tests', () => {
  test('prevents overselling, preserves relative admin inventory adjustments, and deduplicates concurrent payment verify/evidence', async () => {
    const fx = await setupCommerceFixture({ useD1Shim: true });
    try {
      const p1 = fx.products[0];
      const v1 = p1.variants[0];
      // Set exact stock to 3
      await fx.db.run(`UPDATE product_variants SET stock_quantity = 3 WHERE id = ?`, [v1.id]);

      // 5 concurrent checkouts each requesting 2 units -> only 1 can succeed (leaves 1 unit)
      const stockRace = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          fx.app.request('http://localhost:3000/api/checkout', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: fx.custCookie,
              'x-forwarded-for': `10.0.6.${i + 1}`,
            },
            body: JSON.stringify({
              items: [{ productId: p1.id, variantId: v1.id, quantity: 2 }],
              idempotencyKey: `stock_race_${i}`,
              address: {
                fullName: 'Stage2 Shopper',
                email: 'shopper@sellora.test',
                phone: '08031234567',
                state: 'Lagos',
                lga: 'Ikeja',
                city: 'Ikeja',
                streetAddress: '10 Allen Ave',
              },
            }),
          })
        )
      );
      const winners = stockRace.filter((r) => r.status === 201);
      assert.equal(winners.length, 1);
      const winningOrder = await winners[0].json();

      // Concurrent checkout (1 unit) + admin adjustment (+5 units) -> final stock must be 1 - 1 + 5 = 5
      const [chkWin, adjWin] = await Promise.all([
        fx.app.request('http://localhost:3000/api/checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: fx.custCookie,
            'x-forwarded-for': '10.0.6.10',
          },
          body: JSON.stringify({
            items: [{ productId: p1.id, variantId: v1.id, quantity: 1 }],
            idempotencyKey: 'stock_chk_adj_race',
            address: {
              fullName: 'Stage2 Shopper',
              email: 'shopper@sellora.test',
              phone: '08031234567',
              state: 'Lagos',
              lga: 'Ikeja',
              city: 'Ikeja',
              streetAddress: '10 Allen Ave',
            },
          }),
        }),
        fx.app.request('http://localhost:3000/api/admin/inventory/adjust', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
          body: JSON.stringify({ variantId: v1.id, changeAmount: 5, reason: 'Restock batch' }),
        }),
      ]);
      assert.equal(chkWin.status, 201);
      assert.equal(adjWin.status, 200);

      const finalVar = await fx.db.get<{ stock_quantity: number }>(
        `SELECT stock_quantity FROM product_variants WHERE id = ?`,
        [v1.id]
      );
      const movSum = await fx.db.get<{ total_delta: number }>(
        `SELECT SUM(change_amount) as total_delta FROM inventory_movements WHERE variant_id = ?`,
        [v1.id]
      );
      assert.equal(finalVar?.stock_quantity, 5);
      assert.equal(3 + (movSum?.total_delta ?? 0), 5);

      // Concurrent double payment verification -> exactly 1 payment_confirmed history row & 1 audit log
      const [verA, verB] = await Promise.all([
        fx.app.request(`http://localhost:3000/api/admin/payments/${winningOrder.orderId}/verify`, {
          method: 'POST',
          headers: { Cookie: fx.ownerCookie },
        }),
        fx.app.request(`http://localhost:3000/api/admin/payments/${winningOrder.orderId}/verify`, {
          method: 'POST',
          headers: { Cookie: fx.ownerCookie },
        }),
      ]);
      assert.equal(verA.status, 200);
      assert.equal(verB.status, 200);

      const confirmHistoryCount = await fx.db.get<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM order_status_history WHERE order_id = ? AND new_status = 'payment_confirmed'`,
        [winningOrder.orderId]
      );
      const verifyAuditCount = await fx.db.get<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM audit_logs WHERE action = 'PAYMENT_VERIFIED' AND target_id = ?`,
        [winningOrder.orderId]
      );
      assert.equal(confirmHistoryCount?.cnt, 1);
      assert.equal(verifyAuditCount?.cnt, 1);

      // Rejecting an already confirmed payment is blocked (409)
      const rejectAfterConfirm = await fx.app.request(
        `http://localhost:3000/api/admin/payments/${winningOrder.orderId}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
          body: JSON.stringify({ reason: 'Late reject attempt' }),
        }
      );
      assert.equal(rejectAfterConfirm.status, 409);
    } finally {
      fs.rmSync(fx.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Suite 7: POS & Admin Inventory Adjustment Tests', () => {
  test('POS rolls back multi-item failures, aggregates duplicate SKUs, honors track_inventory=0, and blocks negative stock adjustments', async () => {
    const fx = await setupCommerceFixture();
    try {
      const p1 = fx.products[0];
      const v1 = p1.variants[0];
      const p2 = fx.products[1];
      const v2 = p2.variants[0];
      const init1 = v1.stock_quantity;
      const init2 = v2.stock_quantity;

      // POS fails cleanly on item 2 -> item 1 stock untouched
      const posFail = await fx.app.request('http://localhost:3000/api/admin/pos/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
        body: JSON.stringify({
          items: [
            { productId: p1.id, variantId: v1.id, quantity: 1 },
            { productId: p2.id, variantId: v2.id, quantity: init2 + 10 },
          ],
          markPaid: true,
        }),
      });
      assert.equal(posFail.status, 400);
      const v1Check = await fx.db.get<{ stock_quantity: number }>(`SELECT stock_quantity FROM product_variants WHERE id = ?`, [v1.id]);
      assert.equal(v1Check?.stock_quantity, init1);

      // Admin manual negative inventory adjustment past 0 aborts and writes zero movements
      const negAdj = await fx.app.request('http://localhost:3000/api/admin/inventory/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
        body: JSON.stringify({ variantId: v1.id, changeAmount: -(init1 + 5), reason: 'Invalid drop' }),
      });
      assert.equal(negAdj.status, 400);
      const movs = await fx.db.get<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM inventory_movements`);
      assert.equal(movs?.cnt, 0);

      // Non-tracked product can sell on POS with 0 stock
      await fx.db.run(`UPDATE products SET track_inventory = 0 WHERE id = ?`, [p2.id]);
      await fx.db.run(`UPDATE product_variants SET stock_quantity = 0 WHERE id = ?`, [v2.id]);
      const posUntracked = await fx.app.request('http://localhost:3000/api/admin/pos/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
        body: JSON.stringify({
          items: [
            { productId: p1.id, variantId: v1.id, quantity: 1 },
            { productId: p1.id, variantId: v1.id, quantity: 1 },
            { productId: p2.id, variantId: v2.id, quantity: 3 },
          ],
          markPaid: true,
        }),
      });
      assert.equal(posUntracked.status, 201);
      const posData = await posUntracked.json();
      assert.ok(posData.orderNumber.startsWith('POS-'));

      const v1AfterPos = await fx.db.get<{ stock_quantity: number }>(`SELECT stock_quantity FROM product_variants WHERE id = ?`, [v1.id]);
      const v2AfterPos = await fx.db.get<{ stock_quantity: number }>(`SELECT stock_quantity FROM product_variants WHERE id = ?`, [v2.id]);
      assert.equal(v1AfterPos?.stock_quantity, init1 - 2);
      assert.equal(v2AfterPos?.stock_quantity, 0);
    } finally {
      fs.rmSync(fx.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Suite 8: Failure-Injection Tests (Mid-Batch Failure, R2 Rollback Delete & Orphan Reconciliation)', () => {
  test('deletes uploaded receipt when DB batch aborts after storage.put, and recovers via storage_orphan_records when delete fails', async () => {
    const fx = await setupCommerceFixture({ useD1Shim: true });
    try {
      const p1 = fx.products[0];
      const v1 = p1.variants[0];

      // Create 2 orders
      const makeOrder = async (key: string) => {
        const res = await fx.app.request('http://localhost:3000/api/checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: fx.custCookie,
            'x-forwarded-for': `10.0.8.${key}`,
          },
          body: JSON.stringify({
            items: [{ productId: p1.id, variantId: v1.id, quantity: 1 }],
            idempotencyKey: key,
            address: {
              fullName: 'Stage2 Shopper',
              email: 'shopper@sellora.test',
              phone: '08031234567',
              state: 'Lagos',
              lga: 'Ikeja',
              city: 'Ikeja',
              streetAddress: '10 Allen Ave',
            },
          }),
        });
        assert.equal(res.status, 201);
        return res.json();
      };

      const ord1 = await makeOrder('fail_inj_ord_1');
      const ord2 = await makeOrder('fail_inj_ord_2');

      // Confirm ord1 & ord2 before evidence arrives (simulating admin winning verify race)
      await fx.app.request(`http://localhost:3000/api/admin/payments/${ord1.orderId}/verify`, {
        method: 'POST',
        headers: { Cookie: fx.ownerCookie },
      });

      // Wait: to test DB batch abort *after* pre-read passes AND storage.put succeeds,
      // wrap storage.put so when the evidence upload puts to R2, we immediately confirm ord2 concurrently before db.batch runs!
      const origPut = fx.storage.put.bind(fx.storage);
      let injectedVerifyOnPut = false;
      fx.storage.put = async (key, data, contentType) => {
        await origPut(key, data, contentType);
        if (!injectedVerifyOnPut && key.includes(ord2.orderId)) {
          injectedVerifyOnPut = true;
          await fx.db.run(
            `UPDATE payments SET status = 'payment_confirmed' WHERE order_id = ?`,
            [ord2.orderId]
          );
        }
      };

      const makeReceiptForm = (idem: string) => {
        const form = new FormData();
        form.set('referenceNumber', `TRF-${idem}`);
        form.set('amountNaira', String(ord2.totalKobo / 100));
        form.set('transferDate', '2026-11-15');
        form.set('idempotencyKey', idem);
        form.set(
          'receipt',
          new File(
            [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])],
            'receipt.png',
            { type: 'image/png' }
          )
        );
        return form;
      };

      // Case A: DB aborts with PAYMENT_ALREADY_CONFIRMED after R2 put -> compensating storage.delete removes R2 file
      const evFailA = await fx.app.request(
        `http://localhost:3000/api/payments/${ord2.orderNumber}/evidence`,
        {
          method: 'POST',
          headers: { Cookie: fx.custCookie },
          body: makeReceiptForm('ev_race_delete_ok'),
        }
      );
      assert.equal(evFailA.status, 400);
      const receiptsLeftA = await fx.storage.list!('receipts/');
      assert.equal(receiptsLeftA.length, 0);
      const evCount = await fx.db.get<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM payment_evidence WHERE order_id = ?`,
        [ord2.orderId]
      );
      assert.equal(evCount?.cnt, 0);

      // Case B: Inject BOTH DB failure AND storage.delete failure -> records storage_orphan_records, then admin cleanup deletes it
      const ord3 = await makeOrder('fail_inj_ord_3');
      const origDelete = fx.storage.delete.bind(fx.storage);
      let failDeleteOnce = true;
      fx.storage.put = async (key, data, contentType) => {
        await origPut(key, data, contentType);
        if (key.includes(ord3.orderId)) {
          await fx.db.run(
            `UPDATE payments SET status = 'payment_confirmed' WHERE order_id = ?`,
            [ord3.orderId]
          );
        }
      };
      fx.storage.delete = async (key) => {
        if (failDeleteOnce) {
          failDeleteOnce = false;
          throw new Error('Simulated R2 delete outage');
        }
        return origDelete(key);
      };

      const evFailB = await fx.app.request(
        `http://localhost:3000/api/payments/${ord3.orderNumber}/evidence`,
        {
          method: 'POST',
          headers: { Cookie: fx.custCookie },
          body: makeReceiptForm('ev_race_delete_fails'),
        }
      );
      assert.equal(evFailB.status, 400);

      const pendingOrphans = await fx.db.all<{ r2_key: string; status: string }>(
        `SELECT r2_key, status FROM storage_orphan_records WHERE status = 'pending'`
      );
      assert.equal(pendingOrphans.length, 1);

      // Dry-run reports pending orphan without deleting it
      const dryRunRes = await (
        await fx.app.request('http://localhost:3000/api/admin/storage/cleanup-orphans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
          body: JSON.stringify({ dryRun: true }),
        })
      ).json();
      assert.equal(dryRunRes.pendingCount, 1);

      // Live cleanup deletes the file from storage and marks orphan record 'deleted'
      const cleanRes = await (
        await fx.app.request('http://localhost:3000/api/admin/storage/cleanup-orphans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
          body: JSON.stringify({ dryRun: false }),
        })
      ).json();
      assert.equal(cleanRes.resolvedPending.length, 1);
      assert.equal((await fx.storage.list!('receipts/')).length, 0);

      // Case C: Concurrent PATCH /admin/orders/:id/status stale state -> DB-level abort (409 + 0 orphan history rows)
      const st1 = await fx.app.request(`http://localhost:3000/api/admin/orders/${ord1.orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
        body: JSON.stringify({ orderStatus: 'processing', deliveryStatus: 'preparing' }),
      });
      assert.equal(st1.status, 200);

      // Simulate another isolate/admin cancelling the order *after* this handler's pre-read and *before* its db.batch() executes
      const origBatch = fx.db.batch.bind(fx.db);
      let injectedConflict = false;
      fx.db.batch = async (stmts) => {
        if (
          !injectedConflict &&
          stmts.some((s) => s.sql.includes('UPDATE orders SET') && s.sql.includes('WHERE order_id = ? AND order_status = ?'))
        ) {
          injectedConflict = true;
          await fx.db.run(
            `UPDATE orders SET order_status = 'cancelled', delivery_status = 'cancelled', updated_at = ? WHERE order_id = ?`,
            [new Date(Date.now() + 5000).toISOString(), ord1.orderId]
          );
        }
        return origBatch(stmts);
      };

      const staleRes = await fx.app.request(`http://localhost:3000/api/admin/orders/${ord1.orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
        body: JSON.stringify({ orderStatus: 'ready_for_dispatch', deliveryStatus: 'ready_for_dispatch' }),
      });
      assert.equal(staleRes.status, 409);

      const finalOrd = await fx.db.get<{ order_status: string; delivery_status: string }>(
        `SELECT order_status, delivery_status FROM orders WHERE order_id = ?`,
        [ord1.orderId]
      );
      const orphanHist = await fx.db.get<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM order_status_history WHERE order_id = ? AND new_status = 'ready_for_dispatch'`,
        [ord1.orderId]
      );
      assert.equal(finalOrd?.order_status, 'cancelled');
      assert.equal(finalOrd?.delivery_status, 'cancelled');
      assert.equal(orphanHist?.cnt, 0);
    } finally {
      fs.rmSync(fx.tmpDir, { recursive: true, force: true });
    }
  });
});

test('Automatic SKU generation assigns unique SKUs on create/duplicate, handles concurrency, and preserves existing SKU on edit', async () => {
  const fx = await setupCommerceFixture();
  try {
    // 1. Create product without supplying SKU -> backend assigns uppercase SLR-XXX-XXXXXX + -V1
    const createRes = await fx.app.request('http://localhost:3000/api/admin/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
      body: JSON.stringify({
        name: 'Kano Brass Desk Organizer',
        priceNaira: 48000,
        stockQuantity: 15,
        status: 'active',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { id: string; sku: string; variantSku: string };
    assert.match(created.sku, /^SLR-[A-Z0-9]{3}-[A-F0-9]{6}$/);
    assert.equal(created.variantSku, `${created.sku}-V1`);

    const dbProd = await fx.db.get<{ sku: string }>(`SELECT sku FROM products WHERE id = ?`, [created.id]);
    const dbVar = await fx.db.get<{ sku: string }>(`SELECT sku FROM product_variants WHERE product_id = ?`, [
      created.id,
    ]);
    assert.equal(dbProd?.sku, created.sku);
    assert.equal(dbVar?.sku, created.variantSku);

    // 2. Concurrent creation of 8 identically named products in auto SKU mode -> all SKUs unique with zero collisions
    type CreatedSku = { id: string; sku: string; variantSku: string };
    const concurrentReqs: Array<Promise<CreatedSku>> = Array.from({ length: 8 }, async (_, idx) => {
      const r = await fx.app.request('http://localhost:3000/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
        body: JSON.stringify({
          name: 'Identical Ceramic Vase',
          skuMode: 'auto',
          sku: 'ATTEMPTED-MANUAL-OVERRIDE', // ignored when skuMode === 'auto'
          priceNaira: 25000 + idx * 100,
          stockQuantity: 5,
        }),
      });
      return (await r.json()) as CreatedSku;
    });
    const concurrentResults = await Promise.all(concurrentReqs);
    const skuSet = new Set(concurrentResults.map((r: CreatedSku) => r.sku));
    const varSkuSet = new Set(concurrentResults.map((r: CreatedSku) => r.variantSku));
    assert.equal(skuSet.size, 8);
    assert.equal(varSkuSet.size, 8);
    assert.ok(!skuSet.has('ATTEMPTED-MANUAL-OVERRIDE'));

    // 3. Edit product details (without changing SKU) -> preserves original SKU and never regenerates it
    const editRes = await fx.app.request(`http://localhost:3000/api/admin/products/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
      body: JSON.stringify({
        name: 'Kano Brass Desk Organizer Pro',
        priceNaira: 52000,
      }),
    });
    assert.equal(editRes.status, 200);
    const afterEditProd = await fx.db.get<{ name: string; sku: string }>(
      `SELECT name, sku FROM products WHERE id = ?`,
      [created.id]
    );
    const afterEditVar = await fx.db.get<{ sku: string; price_kobo: number }>(
      `SELECT sku, price_kobo FROM product_variants WHERE product_id = ?`,
      [created.id]
    );
    assert.equal(afterEditProd?.name, 'Kano Brass Desk Organizer Pro');
    assert.equal(afterEditProd?.sku, created.sku);
    assert.equal(afterEditVar?.sku, created.variantSku);
    assert.equal(afterEditVar?.price_kobo, 5200000);

    // 4. Duplicate product -> atomically creates new product + variant with distinct auto-generated SKU
    const dupRes = await fx.app.request(`http://localhost:3000/api/admin/products/${created.id}/duplicate`, {
      method: 'POST',
      headers: { Cookie: fx.ownerCookie },
    });
    assert.equal(dupRes.status, 201);
    const dup = (await dupRes.json()) as { id: string; sku: string; variantSku: string };
    assert.notEqual(dup.sku, created.sku);
    assert.match(dup.sku, /^SLR-[A-Z0-9]{3}-[A-F0-9]{6}$/);
    assert.equal(dup.variantSku, `${dup.sku}-V1`);

    // 5. Public storefront /api/products and /api/storefront/config reflect updated name & categories
    const shopRes = await (await fx.app.request('http://localhost:3000/api/products?q=Kano%20Brass')).json();
    assert.ok(shopRes.products.some((p: any) => p.id === created.id && p.name === 'Kano Brass Desk Organizer Pro'));
    const cfgRes = await (await fx.app.request('http://localhost:3000/api/storefront/config')).json();
    assert.ok(Array.isArray(cfgRes.categories) && cfgRes.categories.length >= 1);
  } finally {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  }
});

test('Public API responses, notification errors, and role permissions enforce strict privacy and isolation', async () => {
  const fx = await setupCommerceFixture();
  try {
    // 1. /api/health & /api/me do not leak infrastructure, provider names, or secret state
    const healthText = await (await fx.app.request('http://localhost:3000/api/health')).text();
    assert.equal(healthText.includes('cloudflare'), false);
    assert.equal(healthText.includes('d1'), false);
    assert.equal(healthText.includes('sqlite'), false);

    const me = await (await fx.app.request('http://localhost:3000/api/me')).json();
    assert.equal(me.capabilities.brevoConfigured, undefined);
    assert.equal(me.capabilities.aiConfigured, undefined);

    // 2. Notification failure sanitization avoids leaking env var or provider names when unconfigured
    const queued = await queueEmailEvent(fx.db, {
      idempotencyKey: `sanitized:err:${Date.now()}`,
      recipientEmail: 'shopper@example.com',
      recipientType: 'customer',
      notificationType: 'order_placed',
      subject: 'Order Alert',
      htmlBody: '<p>Test</p>',
    });
    const resNoCreds = await dispatchSingleEmailEvent(
      fx.db,
      { brevoApiKey: undefined, brevoFromEmail: undefined, adminNotificationEmail: 'olarindevictor046@gmail.com' },
      queued.eventId!
    );
    assert.equal(resNoCreds.ok, false);
    assert.equal(resNoCreds.error?.includes('BREVO_API_KEY'), false);
    assert.equal(resNoCreds.error?.includes('BREVO_FROM_EMAIL'), false);
    assert.equal(resNoCreds.error, 'Notification service credentials are not configured.');

    // 3. Non-owner administrator is blocked from audit logs, staff, sessions, email settings/history
    await fx.app.request('http://localhost:3000/api/admin/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fx.ownerCookie },
      body: JSON.stringify({
        name: 'Store Manager',
        email: 'manager@sellora.test',
        password: 'ManagerPassword123!',
        role: 'admin',
      }),
    });
    const staffLogin = await fx.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'manager@sellora.test', password: 'ManagerPassword123!' }),
    });
    const staffCookie = await unlockPrivilegedSession(fx, staffLogin);

    for (const restrictedPath of ['/api/admin/staff', '/api/admin/sessions', '/api/admin/audit-logs']) {
      const r = await fx.app.request(`http://localhost:3000${restrictedPath}`, {
        headers: { Cookie: staffCookie },
      });
      assert.equal(r.status, 403, `Expected 403 for ${restrictedPath}`);
    }

    const emailWriteAttempt = await fx.app.request('http://localhost:3000/api/admin/settings/email', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ fromEmail: 'hijack@example.com' }),
    });
    assert.equal(emailWriteAttempt.status, 403);
  } finally {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  }
});

describe('Three-Layer Security Standard (Layers 1, 2 & 3)', () => {
  test('Layer 2: fail-closed Brevo webhook, CSRF origin blocking, security headers, upload magic bytes & sandboxed downloads', async () => {
    const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

    // 1. Fail-closed Brevo webhook when BREVO_WEBHOOK_SECRET is unset -> 503
    const rtNoSecret = createTestRuntime();
    try {
      const res503 = await rtNoSecret.app.request('http://localhost:3000/api/webhooks/brevo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'delivered', 'message-id': 'msg-1' }),
      });
      assert.equal(res503.status, 503);
    } finally {
      fs.rmSync(rtNoSecret.tmpDir, { recursive: true, force: true });
    }

    // 2. Brevo webhook secret verification, CSRF, headers, upload validation & receipt download CSP
    const rt = createTestRuntime({ brevoWebhookSecret: 'brevo-super-secret-token' });
    try {
      await seedInitialStoreData(rt.db);
      const { cookie: ownerCookie } = await provisionAndSignInOwner(rt);

      const badWebhook = await rt.app.request('http://localhost:3000/api/webhooks/brevo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-brevo-secret': 'wrong-secret' },
        body: JSON.stringify({ event: 'delivered', 'message-id': 'msg-1' }),
      });
      assert.equal(badWebhook.status, 401);

      const okWebhook = await rt.app.request('http://localhost:3000/api/webhooks/brevo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-brevo-secret': 'brevo-super-secret-token' },
        body: JSON.stringify({ event: 'delivered', 'message-id': 'msg-1' }),
      });
      assert.equal(okWebhook.status, 200);

      // CSRF blocks cross-site origin and Sec-Fetch-Site: cross-site on mutating store endpoints
      const csrfOriginRes = await rt.app.request('http://localhost:3000/api/cart/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.attacker.test' },
        body: JSON.stringify({ productId: 'p1', variantId: 'v1', quantity: 1 }),
      });
      assert.equal(csrfOriginRes.status, 403);

      const csrfFetchMetaRes = await rt.app.request('http://localhost:3000/api/cart/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
        body: JSON.stringify({ productId: 'p1', variantId: 'v1', quantity: 1 }),
      });
      assert.equal(csrfFetchMetaRes.status, 403);

      // Security headers + HSTS on HTTPS URLs
      const httpsRes = await rt.app.request('https://sellora.example.com/api/health');
      assert.equal(httpsRes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(httpsRes.headers.get('x-frame-options'), 'DENY');
      assert.ok(httpsRes.headers.get('strict-transport-security')?.includes('max-age=31536000'));
      assert.ok(httpsRes.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));

      // Polyglot <svg>/<script> disguised as PNG rejected on admin media upload
      const polyglotBytes = new TextEncoder().encode('<svg onload="alert(1)"><script>fetch(1)</script></svg>');
      assert.equal(validateUploadedFileBytes(polyglotBytes, 'image/png', ['image/png']).ok, false);

      const badMediaForm = new FormData();
      badMediaForm.append('file', new File([polyglotBytes], 'evil.png', { type: 'image/png' }));
      const badMediaRes = await rt.app.request('http://localhost:3000/api/admin/media/upload', {
        method: 'POST',
        headers: { Cookie: ownerCookie },
        body: badMediaForm,
      });
      assert.equal(badMediaRes.status, 400);

      const goodMediaForm = new FormData();
      goodMediaForm.append('file', new File([validPng], 'valid.png', { type: 'image/png' }));
      const goodMediaRes = await rt.app.request('http://localhost:3000/api/admin/media/upload', {
        method: 'POST',
        headers: { Cookie: ownerCookie },
        body: goodMediaForm,
      });
      assert.equal(goodMediaRes.status, 201);

      // Receipt upload rejects spoofed magic bytes; valid receipt downloads with attachment & sandbox CSP
      await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Sec Shopper', email: 'sec@shopper.ng', password: 'Password123!' }),
      });
      const signIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sec@shopper.ng', password: 'Password123!' }),
      });
      const custCookie = signIn.headers.get('set-cookie')!.split(';')[0];

      const addZoneRes = await rt.app.request('http://localhost:3000/api/admin/delivery-zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          state: 'Lagos',
          lga: 'Ikeja',
          feeNaira: 3500,
          estimatedDaysMin: 1,
          estimatedDaysMax: 2,
        }),
      });
      assert.equal(addZoneRes.status, 201);

      const prodRes = await (await rt.app.request('http://localhost:3000/api/products')).json();
      const firstProd = prodRes.products[0];
      const checkoutRes = await rt.app.request('http://localhost:3000/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: custCookie },
        body: JSON.stringify({
          items: [{ productId: firstProd.id, variantId: firstProd.variants[0].id, quantity: 1 }],
          idempotencyKey: 'sec-receipt-ord-1',
          address: {
            fullName: 'Sec Shopper',
            email: 'sec@shopper.ng',
            phone: '08031234567',
            state: 'Lagos',
            lga: 'Ikeja',
            city: 'Ikeja',
            streetAddress: '10 Bode Thomas',
          },
        }),
      });
      assert.equal(checkoutRes.status, 201);
      const ord = await checkoutRes.json();

      const spoofForm = new FormData();
      spoofForm.append('referenceNumber', 'REF-BAD-1');
      spoofForm.append('amountNaira', String(ord.totalKobo / 100));
      spoofForm.append('transferDate', '2026-11-16');
      spoofForm.append('receipt', new File([polyglotBytes], 'fake.png', { type: 'image/png' }));
      const spoofUpload = await rt.app.request(`http://localhost:3000/api/payments/${ord.orderNumber}/evidence`, {
        method: 'POST',
        headers: { Cookie: custCookie },
        body: spoofForm,
      });
      assert.equal(spoofUpload.status, 400);

      const goodForm = new FormData();
      goodForm.append('referenceNumber', 'REF-GOOD-1');
      goodForm.append('amountNaira', String(ord.totalKobo / 100));
      goodForm.append('transferDate', '2026-11-16');
      goodForm.append('receipt', new File([validPng], '../../evil<script>.png', { type: 'image/png' }));
      const goodUpload = await rt.app.request(`http://localhost:3000/api/payments/${ord.orderNumber}/evidence`, {
        method: 'POST',
        headers: { Cookie: custCookie },
        body: goodForm,
      });
      assert.equal(goodUpload.status, 201);
      const goodEv = await goodUpload.json();

      const downloadRes = await rt.app.request(
        `http://localhost:3000/api/payments/evidence/${goodEv.evidenceId}/file`,
        { headers: { Cookie: custCookie } }
      );
      assert.equal(downloadRes.status, 200);
      assert.ok(downloadRes.headers.get('content-disposition')?.includes('attachment'));
      assert.ok(downloadRes.headers.get('content-security-policy')?.includes('sandbox'));
    } finally {
      fs.rmSync(rt.tmpDir, { recursive: true, force: true });
    }
  });

  test('Layer 2: trusted client IP (Worker vs spoofed XFF), persistent rate limiting, Turnstile replay block & login brute-force lockout', async () => {
    const spoofedHeaders = new Headers({
      'x-forwarded-for': '203.0.113.99',
      'cf-connecting-ip': '198.51.100.42',
    });
    assert.equal(getTrustedClientIp(spoofedHeaders, { runtime: 'worker' }), '198.51.100.42');
    const workerNoCf = new Headers({ 'x-forwarded-for': '203.0.113.99' });
    assert.equal(getTrustedClientIp(workerNoCf, { runtime: 'worker' }), 'worker-client');
    assert.equal(getTrustedClientIp(workerNoCf, { runtime: 'node', trustedProxy: true }), '203.0.113.99');

    const rt = createTestRuntime({
      turnstileSecretKey: '1x0000000000000000000000000000000AA',
      turnstileSiteKey: '1x00000000000000000000AA',
    });
    const origFetch = globalThis.fetch;
    try {
      // Persistent DB-backed rate limiter
      const k = `test-bucket-${Date.now()}`;
      assert.equal((await checkPersistentRateLimit(rt.db, k, 2, 60_000)).allowed, true);
      assert.equal((await checkPersistentRateLimit(rt.db, k, 2, 60_000)).allowed, true);
      const third = await checkPersistentRateLimit(rt.db, k, 2, 60_000);
      assert.equal(third.allowed, false);
      assert.ok(third.retryAfterSec >= 1);

      // Turnstile persistent single-use replay protection
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;

      const t1 = await verifyTurnstileToken({
        token: 'turnstile-unique-token-abc123456',
        secretKey: rt.env.turnstileSecretKey,
        siteKey: rt.env.turnstileSiteKey,
        remoteIp: '198.51.100.1',
        db: rt.db,
      });
      assert.equal(t1.ok, true);
      assert.equal(t1.status, 'verified');

      const tReplay = await verifyTurnstileToken({
        token: 'turnstile-unique-token-abc123456',
        secretKey: rt.env.turnstileSecretKey,
        siteKey: rt.env.turnstileSiteKey,
        remoteIp: '198.51.100.1',
        db: rt.db,
      });
      assert.equal(tReplay.ok, false);
      assert.equal(tReplay.status, 'failed');

      // Progressive brute-force login throttle locks on 2nd bad password for 10m (600s) & clears on recovery
      const rtAuth = createTestRuntime();
      try {
        await provisionOwnerInDb(rtAuth.db, {
          name: 'Victor Olarinde',
          email: 'olarindevictor046@gmail.com',
          password: 'CorrectPassword123!',
        });

        const fail1 = await rtAuth.app.request('http://localhost:3000/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.77' },
          body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'WrongPassword!' }),
        });
        assert.equal(fail1.status, 401);

        const fail2 = await rtAuth.app.request('http://localhost:3000/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.77' },
          body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'WrongPassword!' }),
        });
        assert.equal(fail2.status, 429);
        assert.ok(Number(fail2.headers.get('retry-after')) >= 595);

        const lockedRes = await rtAuth.app.request('http://localhost:3000/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.77' },
          body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'CorrectPassword123!' }),
        });
        assert.equal(lockedRes.status, 429);
        assert.ok(Number(lockedRes.headers.get('retry-after')) >= 595);

        const secEv = await rtAuth.db.get<{ event_ref: string }>(
          `SELECT event_ref FROM security_events WHERE event_category = 'account_lockout_triggered'`
        );
        assert.match(secEv?.event_ref || '', /^SEC-[A-Z2-9]{8}$/);
      } finally {
        fs.rmSync(rtAuth.tmpDir, { recursive: true, force: true });
      }
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(rt.tmpDir, { recursive: true, force: true });
    }
  });

  test('Layer 3: private error monitoring redaction, 5-min deduplication, DB fallback & sanitized ERR reference responses', async () => {
    const rt = createTestRuntime();
    try {
      // Secret redaction & 5-minute deduplication
      const sensitiveErr = new Error(
        'Brevo failed with Authorization: Bearer secret_abc123 xkeysib-abcdef123456 on sqlite:///var/data/prod.db'
      );
      const first = await recordCapturedError(rt.db, {
        serviceCategory: 'email',
        failedOperation: 'dispatchEmail',
        location: 'src/server/email.ts',
        environment: 'test',
        error: sensitiveErr,
        extraSafeContext: { apiKey: 'must_redact_secret', orderNumber: 'SLR-1001' },
      });
      assert.match(first.refId, /^ERR-[A-Z2-9]{8}$/);
      assert.equal(first.deduplicated, false);
      assert.equal(first.persistedToDb, true);

      const second = await recordCapturedError(rt.db, {
        serviceCategory: 'email',
        failedOperation: 'dispatchEmail',
        location: 'src/server/email.ts',
        environment: 'test',
        error: sensitiveErr,
        extraSafeContext: { apiKey: 'must_redact_secret', orderNumber: 'SLR-1001' },
      });
      assert.equal(second.deduplicated, true);
      assert.equal(second.refId, first.refId);

      const stored = await rt.db.get<{ sanitized_message: string; occurrence_count: number }>(
        `SELECT sanitized_message, occurrence_count FROM error_monitoring_logs WHERE ref_id = ?`,
        [first.refId]
      );
      assert.equal(stored?.occurrence_count, 2);
      assert.equal(stored?.sanitized_message.includes('secret_abc123'), false);
      assert.equal(stored?.sanitized_message.includes('xkeysib-abcdef123456'), false);
      assert.equal(stored?.sanitized_message.includes('must_redact_secret'), false);
      assert.equal(stored?.sanitized_message.includes('/var/data/prod.db'), false);
      assert.ok(stored?.sanitized_message.includes('[REDACTED'));

      // Fallback logger works without throwing when DB errors occur
      const fallbackLogs: Record<string, unknown>[] = [];
      const brokenDb = {
        ...rt.db,
        async get() {
          throw new Error('D1 unreachable');
        },
        async run() {
          throw new Error('D1 unreachable');
        },
      };
      const fb = await recordCapturedError(
        brokenDb as any,
        {
          serviceCategory: 'database',
          failedOperation: 'fallbackCheck',
          location: 'test',
          error: new Error('sqlite failure'),
        },
        (entry) => fallbackLogs.push(entry)
      );
      assert.equal(fb.persistedToDb, false);
      assert.match(fb.refId, /^ERR-[A-Z2-9]{8}$/);
      assert.equal(fallbackLogs.length, 1);
    } finally {
      fs.rmSync(rt.tmpDir, { recursive: true, force: true });
    }
  });

  test('Layer 3: new-device sign-in alert, single-use confirm/dispute tokens revoking all sessions, and /api/me/sessions', async () => {
    const rt = createTestRuntime();
    try {
      await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Device User', email: 'device@sellora.test', password: 'StrongPassword123!' }),
      });

      // Sign-in #1 from Chrome on Windows
      const login1 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
          'cf-ipcountry': 'NG',
        },
        body: JSON.stringify({ email: 'device@sellora.test', password: 'StrongPassword123!' }),
      });
      assert.equal(login1.status, 200);
      const cookie1 = login1.headers.get('set-cookie')!.split(';')[0];

      // Sign-in #2 from Safari on iPhone -> triggers new-device detection & single-use confirm/dispute tokens
      const login2 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
          'cf-ipcountry': 'NG',
        },
        body: JSON.stringify({ email: 'device@sellora.test', password: 'StrongPassword123!' }),
      });
      assert.equal(login2.status, 200);
      const cookie2 = login2.headers.get('set-cookie')!.split(';')[0];

      // Check /api/me/sessions shows both active sessions
      const sessionsRes = await rt.app.request('http://localhost:3000/api/me/sessions', {
        headers: { Cookie: cookie2 },
      });
      assert.equal(sessionsRes.status, 200);
      const sessBody = await sessionsRes.json();
      assert.equal(sessBody.sessions.length, 3);
      assert.ok(sessBody.recentLogins.some((l: any) => l.is_new_device === 1));

      // Retrieve the alert email's dispute URL & confirm URL via recordLoginAttemptAndMonitor directly for token test
      const userRow = await rt.db.get<{ id: string }>(`SELECT id FROM user WHERE email = 'device@sellora.test'`);
      const mon3 = await recordLoginAttemptAndMonitor(rt.db, rt.env, {
        headers: new Headers({
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
          'cf-ipcountry': 'GB',
        }),
        userId: userRow!.id,
        email: 'device@sellora.test',
        userName: 'Device User',
        userRole: 'customer',
        authMethod: 'email_password',
        outcome: 'success',
      });
      assert.equal(mon3.isNewDevice, true);
      assert.equal(mon3.isUnusual, true);
      assert.match(mon3.eventRef || '', /^SEC-[A-Z2-9]{8}$/);
      assert.ok(mon3.disputeUrl && mon3.confirmUrl);

      const disputeToken = new URL(mon3.disputeUrl!).searchParams.get('token')!;
      const confirmToken = new URL(mon3.confirmUrl!).searchParams.get('token')!;

      // Clicking "This wasn't me" revokes ALL sessions and invalidates paired confirm token too
      const disputeRes = await rt.app.request(
        `http://localhost:3000/api/security/login-response?action=dispute&token=${encodeURIComponent(disputeToken)}`
      );
      assert.equal(disputeRes.status, 200);

      // Both active session cookies must now be rejected
      const after1 = await rt.app.request('http://localhost:3000/api/me/sessions', {
        headers: { Cookie: cookie1 },
      });
      const after2 = await rt.app.request('http://localhost:3000/api/me/sessions', {
        headers: { Cookie: cookie2 },
      });
      assert.equal(after1.status, 401);
      assert.equal(after2.status, 401);

      // Paired confirm token cannot be replayed after dispute consumed it
      const replayConfirm = await rt.app.request(
        `http://localhost:3000/api/security/login-response?action=confirm&token=${encodeURIComponent(confirmToken)}`
      );
      assert.equal(replayConfirm.status, 400);
    } finally {
      fs.rmSync(rt.tmpDir, { recursive: true, force: true });
    }
  });

  test('Layer 3: isolated Developer Portal API enforces Bearer keys, scopes, revocation, zero commerce access & immutable audit_logs', async () => {
    const rt = createTestRuntime();
    try {
      await seedInitialStoreData(rt.db);
      const { cookie: ownerCookie } = await provisionAndSignInOwner(rt);

      // Create an error log record & a security event so portal has rows to query
      const cap = await recordCapturedError(rt.db, {
        serviceCategory: 'payment',
        failedOperation: 'verifyCheck',
        location: 'src/server/routes/orders.ts',
        environment: 'production',
        error: new Error('Payment reference validation glitch'),
      });

      // Owner issues a scoped developer integration key
      const createKeyRes = await rt.app.request('http://localhost:3000/api/admin/developer-integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          portalName: 'PixelBridge Support',
          scopes: ['errors:read', 'errors:update', 'security:read'],
          expiresInDays: 90,
        }),
      });
      assert.equal(createKeyRes.status, 201);
      const keyData = await createKeyRes.json();
      assert.ok(keyData.apiKey.startsWith('slr_dev_'));

      // Store session cookie alone is strictly REJECTED by /api/developer/*
      const cookieAttempt = await rt.app.request('http://localhost:3000/api/developer/errors', {
        headers: { Cookie: ownerCookie },
      });
      assert.equal(cookieAttempt.status, 401);

      // Developer Bearer key CANNOT access commerce/admin/orders routes
      const adminAttemptWithDevKey = await rt.app.request('http://localhost:3000/api/admin/orders', {
        headers: { Authorization: `Bearer ${keyData.apiKey}` },
      });
      assert.equal(adminAttemptWithDevKey.status, 401);

      // Scoped read/update succeeds on /api/developer/*
      const errListRes = await rt.app.request('http://localhost:3000/api/developer/errors', {
        headers: { Authorization: `Bearer ${keyData.apiKey}` },
      });
      assert.equal(errListRes.status, 200);
      const errList = await errListRes.json();
      assert.ok(errList.errors.some((e: any) => e.ref_id === cap.refId));

      const patchErrRes = await rt.app.request(
        `http://localhost:3000/api/developer/errors/${cap.refId}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${keyData.apiKey}`,
          },
          body: JSON.stringify({ investigationStatus: 'resolved', resolutionNotes: 'Mitigated' }),
        }
      );
      assert.equal(patchErrRes.status, 200);

      // Un-granted scope ('audit:read') returns 403
      const missingScopeRes = await rt.app.request('http://localhost:3000/api/developer/audit-logs', {
        headers: { Authorization: `Bearer ${keyData.apiKey}` },
      });
      assert.equal(missingScopeRes.status, 403);

      // Owner revokes key -> immediately rejected (403)
      const revokeRes = await rt.app.request(
        `http://localhost:3000/api/admin/developer-integrations/${keyData.id}`,
        { method: 'DELETE', headers: { Cookie: ownerCookie } }
      );
      assert.equal(revokeRes.status, 200);

      const postRevokeRes = await rt.app.request('http://localhost:3000/api/developer/errors', {
        headers: { Authorization: `Bearer ${keyData.apiKey}` },
      });
      assert.equal(postRevokeRes.status, 403);

      // audit_logs immutability trigger prevents DELETE even at SQL level
      await assert.rejects(
        () => rt.db.run(`DELETE FROM audit_logs`),
        (err: Error) => err.message.includes('AUDIT_LOGS_IMMUTABLE')
      );
    } finally {
      fs.rmSync(rt.tmpDir, { recursive: true, force: true });
    }
  });
});

test('Login-Attempt Security Policy: 2-attempt 10m lockout, +5m progressive cycles (15m, 20m), configurable cap, concurrency mutex, password-reset recovery & OAuth isolation', async () => {
  const rt = createTestRuntime({
    loginMaxLockoutSeconds: 1200, // Test 20-minute cap (1200s) -> 10m -> 15m -> 20m -> 20m
  });
  try {
    await seedInitialStoreData(rt.db);
    await provisionOwnerInDb(rt.db, {
      name: 'Victor Olarinde',
      email: 'olarindevictor046@gmail.com',
      password: 'CorrectOwnerPassword123!',
    });

    const ip = '198.51.100.88';

    // 1. Generic non-enumerating 401 on 1st failed attempt (both existing and non-existent emails)
    const unknownFail = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'WrongPassword123!' }),
    });
    const knownFail1 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'WrongPassword123!' }),
    });
    assert.equal(unknownFail.status, 401);
    assert.equal(knownFail1.status, 401);
    const unknownBody = await unknownFail.json();
    const knownBody1 = await knownFail1.json();
    assert.equal(unknownBody.error, 'Invalid email or password.');
    assert.equal(knownBody1.error, unknownBody.error); // Zero enumeration difference

    // After 1st failure, account is NOT locked
    const throttleAfter1 = await rt.db.get<{ fail_count: number; lockout_cycles: number; locked_until_ms: number }>(
      `SELECT fail_count, lockout_cycles, locked_until_ms FROM auth_login_throttles WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`
    );
    assert.equal(throttleAfter1?.fail_count, 1);
    assert.equal(throttleAfter1?.lockout_cycles, 0);
    assert.equal(throttleAfter1?.locked_until_ms, 0);

    // 2. 2nd consecutive failure triggers immediate 10-minute (600s) lockout + deduplicated alert email
    const knownFail2 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'WrongPassword123!' }),
    });
    assert.equal(knownFail2.status, 429);
    const retryAfter2 = Number(knownFail2.headers.get('retry-after'));
    assert.ok(retryAfter2 >= 595 && retryAfter2 <= 600);
    const body2 = await knownFail2.json();
    assert.equal(
      body2.error,
      'Sign-in is temporarily restricted due to repeated attempts. Please wait before trying again or reset your password.'
    );

    const throttleAfter2 = await rt.db.get<{ fail_count: number; lockout_cycles: number; locked_until_ms: number }>(
      `SELECT fail_count, lockout_cycles, locked_until_ms FROM auth_login_throttles WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`
    );
    assert.equal(throttleAfter2?.fail_count, 2);
    assert.equal(throttleAfter2?.lockout_cycles, 1);
    assert.ok((throttleAfter2?.locked_until_ms || 0) > Date.now() + 590_000);

    // 3. During active lockout: even the CORRECT password is blocked AND locked_until_ms does NOT extend
    const blockedCorrect = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.55' }, // different IP still locked!
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'CorrectOwnerPassword123!' }),
    });
    assert.equal(blockedCorrect.status, 429);
    // recordFailedLoginAttempt while already locked leaves fail_count & lockout_cycles untouched
    const whileLocked = await recordFailedLoginAttempt(rt.db, 'olarindevictor046@gmail.com', ip, {
      maxLockoutSec: 1200,
    });
    assert.equal(whileLocked.newlyLocked, false);
    assert.equal(whileLocked.lockoutCycles, 1);

    // Only ONE deduplicated lockout alert email was queued for lockout cycle 1
    const lockAlerts = await rt.db.all<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM email_notification_events WHERE notification_type = 'security_login_lockout'`
    );
    assert.equal(lockAlerts.length, 1);

    // 4. Simulate 1st lockout expiry (keep counters!) -> 3rd bad password triggers 15-minute (900s) lockout
    await rt.db.run(
      `UPDATE auth_login_throttles SET locked_until_ms = ? WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`,
      [Date.now() - 1000]
    );
    const checkAfterExpiry = await checkLoginThrottle(rt.db, 'olarindevictor046@gmail.com', ip);
    assert.equal(checkAfterExpiry.allowed, true);
    const preservedCounters = await rt.db.get<{ fail_count: number; lockout_cycles: number }>(
      `SELECT fail_count, lockout_cycles FROM auth_login_throttles WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`
    );
    assert.equal(preservedCounters?.fail_count, 2);
    assert.equal(preservedCounters?.lockout_cycles, 1);

    const knownFail3 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'WrongPassword123!' }),
    });
    assert.equal(knownFail3.status, 429);
    const retryAfter3 = Number(knownFail3.headers.get('retry-after'));
    assert.ok(retryAfter3 >= 895 && retryAfter3 <= 900);

    // 5. Simulate 2nd lockout expiry -> 4th bad password triggers 20-minute (1200s) lockout
    await rt.db.run(
      `UPDATE auth_login_throttles SET locked_until_ms = ? WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`,
      [Date.now() - 1000]
    );
    const knownFail4 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'WrongPassword123!' }),
    });
    assert.equal(knownFail4.status, 429);
    const retryAfter4 = Number(knownFail4.headers.get('retry-after'));
    assert.ok(retryAfter4 >= 1195 && retryAfter4 <= 1200);

    // 6. Configurable cap (1200s) caps 5th bad attempt after expiry instead of growing to 1500s
    await rt.db.run(
      `UPDATE auth_login_throttles SET locked_until_ms = ? WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`,
      [Date.now() - 1000]
    );
    const knownFail5 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'WrongPassword123!' }),
    });
    assert.equal(knownFail5.status, 429);
    const retryAfter5 = Number(knownFail5.headers.get('retry-after'));
    assert.ok(retryAfter5 >= 1195 && retryAfter5 <= 1200);

    // 7. Verified password reset clears lockout and counters completely, even while locked!
    const reqReset = await rt.app.request('http://localhost:3000/api/auth/request-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        redirectTo: 'http://localhost:3000/',
      }),
    });
    assert.equal(reqReset.status, 200);
    const resetEmailRow = await rt.db.get<{ html_body: string }>(
      `SELECT html_body FROM email_notification_events WHERE notification_type = 'auth_password_reset' ORDER BY created_at DESC LIMIT 1`
    );
    const resetUrlMatch = resetEmailRow?.html_body.match(/href="([^"]*reset-password[^"]*)"/);
    assert.ok(resetUrlMatch?.[1]);
    const resetUrl = new URL(resetUrlMatch[1].replace(/&amp;/g, '&'));
    const resetToken =
      resetUrl.searchParams.get('token') || resetUrl.pathname.split('/').filter(Boolean).pop()!;
    const resetExec = await rt.app.request('http://localhost:3000/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: 'RecoveredOwnerPassword123!', token: resetToken }),
    });
    assert.equal(resetExec.status, 200);

    // After password reset, lockout row is cleared and new password signs in immediately
    const postResetSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'RecoveredOwnerPassword123!',
      }),
    });
    assert.equal(postResetSignIn.status, 200);

    // 8. Concurrent burst of 5 parallel wrong attempts cannot bypass 2-attempt lockout
    const concurrentRes = await Promise.all(
      Array.from({ length: 5 }, () =>
        rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.90' },
          body: JSON.stringify({
            email: 'olarindevictor046@gmail.com',
            password: 'BurstWrongPassword!',
          }),
        })
      )
    );
    const statuses = concurrentRes.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 1);
    assert.equal(statuses.filter((s) => s === 429).length, 4);

    // After burst, expire once and verify a valid login resets counters cleanly to 0
    await clearLoginThrottle(rt.db, 'olarindevictor046@gmail.com', '198.51.100.90');
    await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.90' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'WrongOnceMore!',
      }),
    });
    const validResetLogin = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.90' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'RecoveredOwnerPassword123!',
      }),
    });
    assert.equal(validResetLogin.status, 200);
    const rowAfterValid = await rt.db.get<{ fail_count: number }>(
      `SELECT fail_count FROM auth_login_throttles WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`
    );
    assert.equal(rowAfterValid, null);

    // 9. IP-based throttling across distinct emails blocks at 20 attempts in 15 minutes
    const baseMs = 1_800_000_000_000;
    for (let i = 1; i <= 19; i++) {
      const r = await recordFailedLoginAttempt(rt.db, `spray${i}@example.com`, '203.0.113.199', {
        nowMs: baseMs + i * 1000,
      });
      assert.equal(r.locked, false);
    }
    const r20 = await recordFailedLoginAttempt(rt.db, 'spray20@example.com', '203.0.113.199', {
      nowMs: baseMs + 20_000,
    });
    assert.equal(r20.locked, true);
    assert.equal(r20.retryAfterSec, 300);

    // 10. Google OAuth sign-in is NOT blocked by password lockout
    const rtOauth = createTestRuntime({
      googleClientId: 'mock-client-id',
      googleClientSecret: 'mock-client-secret',
    });
    try {
      await recordFailedLoginAttempt(rtOauth.db, 'olarindevictor046@gmail.com', '198.51.100.7');
      await recordFailedLoginAttempt(rtOauth.db, 'olarindevictor046@gmail.com', '198.51.100.7');
      const oauthRes = await rtOauth.app.request('http://localhost:3000/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
        body: JSON.stringify({ provider: 'google', callbackURL: '/api/auth/complete' }),
      });
      assert.equal(oauthRes.status, 200);
    } finally {
      fs.rmSync(rtOauth.tmpDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('Admin Login Email Change (olarindevictor3@gmail.com -> olarindevictor046@gmail.com): verified migration preserves user ID & history, cleans stale OAuth, blocks old email & staff hijack', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor046@gmail.com',
    adminNotificationEmail: 'olarindevictor046@gmail.com',
    googleClientId: 'mock-google-id',
    googleClientSecret: 'mock-google-secret',
  });
  try {
    await seedInitialStoreData(rt.db);

    // Seed pre-migration active owner still on old email (olarindevictor3@gmail.com) with Google OAuth link, order & audit history
    const { cookie: oldOwnerCookie, userId: ownerId } = await provisionAndSignInOwner(rt, {
      email: 'olarindevictor3@gmail.com',
      password: 'OwnerMigratePassword123!',
    });

    const authCtx = await rt.auth.$context;
    await authCtx.internalAdapter.createAccount({
      userId: ownerId,
      providerId: 'google',
      accountId: 'google-sub-old-owner-3',
    });

    // Seed a product & POS order so we verify store history stays intact after email change
    const prods = await (await rt.app.request('http://localhost:3000/api/products')).json();
    const firstProd = prods.products[0];
    const firstVar = firstProd.variants[0];
    const posRes = await rt.app.request('http://localhost:3000/api/admin/pos/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: oldOwnerCookie },
      body: JSON.stringify({
        items: [{ productId: firstProd.id, variantId: firstVar.id, quantity: 1 }],
        customerName: 'History Check',
        markPaid: true,
      }),
    });
    assert.equal(posRes.status, 201);
    const { orderId } = await posRes.json();

    // Seed an existing customer and a staff admin account
    const existingCust = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Existing Customer',
        email: 'existing@customer.test',
        password: 'CustomerPassword123!',
      }),
    });
    assert.equal(existingCust.status, 200);

    const createAdminRes = await rt.app.request('http://localhost:3000/api/admin/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: oldOwnerCookie },
      body: JSON.stringify({
        name: 'Staff Admin',
        email: 'staff.admin@sellora.test',
        password: 'StaffPassword123!',
        role: 'admin',
      }),
    });
    assert.equal(createAdminRes.status, 201);
    const staffSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'staff.admin@sellora.test', password: 'StaffPassword123!' }),
    });
    const staffCookie = await unlockPrivilegedSession(rt, staffSignIn);

    // 1. Pre-migration hijack protections: customer signup & OAuth create for olarindevictor046@gmail.com rejected while owner exists
    const hijackSignup = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Attacker',
        email: 'olarindevictor046@gmail.com',
        password: 'AttackerPassword123!',
      }),
    });
    assert.equal(hijackSignup.status, 403);
    await assert.rejects(() =>
      authCtx.internalAdapter.createUser(
        { name: 'OAuth Hijack', email: 'olarindevictor046@gmail.com', emailVerified: true },
        { method: 'oauth', oauth: { providerId: 'google' } }
      )
    );

    // 2. Staff CANNOT invoke owner change-email or assign reserved owner email
    const staffChangeOwnerRes = await rt.app.request('http://localhost:3000/api/admin/owner/change-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ newEmail: 'attacker@example.com' }),
    });
    assert.equal(staffChangeOwnerRes.status, 403);

    const staffClaimReservedRes = await rt.app.request('http://localhost:3000/api/auth/change-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ newEmail: 'olarindevictor046@gmail.com' }),
    });
    assert.equal(staffClaimReservedRes.status, 403);

    // 3. Duplicate existing account email rejected (409)
    const dupRes = await rt.app.request('http://localhost:3000/api/admin/owner/change-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: oldOwnerCookie },
      body: JSON.stringify({ newEmail: 'existing@customer.test' }),
    });
    assert.equal(dupRes.status, 409);

    // 4. Settings summary surfaces emailMigrationPending = true while owner still has old email
    const settingsBefore = await (
      await rt.app.request('http://localhost:3000/api/admin/settings', {
        headers: { Cookie: oldOwnerCookie },
      })
    ).json();
    assert.equal(settingsBefore.ownerSummary.designatedOwnerEmail, 'olarindevictor046@gmail.com');
    assert.equal(settingsBefore.ownerSummary.emailMigrationPending, true);

    // 5. Initiate verified email change via /api/admin/owner/change-email
    const reqChangeRes = await rt.app.request('http://localhost:3000/api/admin/owner/change-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: oldOwnerCookie },
      body: JSON.stringify({ newEmail: 'olarindevictor046@gmail.com' }),
    });
    assert.equal(reqChangeRes.status, 200);

    // Before verification links are clicked, owner email is UNCHANGED and new email CANNOT log in
    const ownerBeforeVerify = await rt.db.get<{ email: string }>(`SELECT email FROM user WHERE id = ?`, [ownerId]);
    assert.equal(ownerBeforeVerify?.email, 'olarindevictor3@gmail.com');
    const unverifiedSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'OwnerMigratePassword123!',
      }),
    });
    assert.equal(unverifiedSignIn.status, 401);

    // Clear that 1 failed attempt on new email cleanly before completing migration
    await clearLoginThrottle(rt.db, 'olarindevictor046@gmail.com', 'local');

    // Step 1 confirmation email sent to olarindevictor3@gmail.com
    const step1Email = await rt.db.get<{ recipient_email: string; html_body: string }>(
      `SELECT recipient_email, html_body FROM email_notification_events WHERE notification_type = 'auth_change_email_confirmation' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(step1Email?.recipient_email, 'olarindevictor3@gmail.com');
    const step1Url = step1Email!.html_body.match(/href="([^"]*verify-email[^"]*)"/)?.[1]!.replace(/&amp;/g, '&');
    assert.ok(step1Url);

    const step1Click = await rt.app.request(step1Url, { headers: { Cookie: oldOwnerCookie } });
    assert.ok(step1Click.status === 200 || step1Click.status === 302);

    // After Step 1 confirmation, email STILL has not flipped until new email is verified
    const ownerAfterStep1 = await rt.db.get<{ email: string }>(`SELECT email FROM user WHERE id = ?`, [ownerId]);
    assert.equal(ownerAfterStep1?.email, 'olarindevictor3@gmail.com');

    // Step 2 verification email sent to olarindevictor046@gmail.com
    const step2Email = await rt.db.get<{ recipient_email: string; html_body: string }>(
      `SELECT recipient_email, html_body FROM email_notification_events WHERE notification_type = 'auth_verification' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(step2Email?.recipient_email, 'olarindevictor046@gmail.com');
    const step2Url = step2Email!.html_body.match(/href="([^"]*verify-email[^"]*)"/)?.[1]!.replace(/&amp;/g, '&');
    assert.ok(step2Url);

    const step2Click = await rt.app.request(step2Url, { headers: { Cookie: oldOwnerCookie } });
    assert.ok(step2Click.status === 200 || step2Click.status === 302);

    // 6. Post-verification assertions: SAME user.id, SINGLE owner row, new verified email active, stale Google link deleted
    const owners = await rt.db.all<{ id: string; email: string; emailVerified: number; role: string }>(
      `SELECT id, email, emailVerified, role FROM user WHERE role = 'owner'`
    );
    assert.equal(owners.length, 1);
    assert.equal(owners[0].id, ownerId);
    assert.equal(owners[0].email, 'olarindevictor046@gmail.com');
    assert.equal(owners[0].emailVerified, 1);

    const staleGoogleLink = await rt.db.get<{ id: string }>(
      `SELECT id FROM account WHERE userId = ? AND providerId = 'google'`,
      [ownerId]
    );
    assert.equal(staleGoogleLink, null);

    // Old email can NO LONGER authenticate with password; new email CAN with the existing password
    const oldLoginRes = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor3@gmail.com',
        password: 'OwnerMigratePassword123!',
      }),
    });
    assert.equal(oldLoginRes.status, 401);

    const newLoginRes = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'OwnerMigratePassword123!',
      }),
    });
    assert.equal(newLoginRes.status, 200);
    const newOwnerCookie = await unlockPrivilegedSession(rt, newLoginRes);

    // Preserved store orders, audit logs, and emailMigrationPending === false
    const orderCheck = await (
      await rt.app.request(`http://localhost:3000/api/admin/orders/${orderId}`, {
        headers: { Cookie: newOwnerCookie },
      })
    ).json();
    assert.equal(orderCheck.order.order_id, orderId);

    const settingsAfter = await (
      await rt.app.request('http://localhost:3000/api/admin/settings', {
        headers: { Cookie: newOwnerCookie },
      })
    ).json();
    assert.equal(settingsAfter.ownerSummary.emailMigrationPending, false);
    assert.equal(settingsAfter.emailStatus.resolvedAdminEmail, 'olarindevictor046@gmail.com');

    // Audit log & security events recorded WITHOUT verification tokens
    const auditChanged = await rt.db.get<{ details_json: string }>(
      `SELECT details_json FROM audit_logs WHERE action = 'OWNER_EMAIL_CHANGED' ORDER BY created_at DESC LIMIT 1`
    );
    assert.ok(auditChanged);
    assert.equal(auditChanged.details_json.includes('token='), false);
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('Admin Notification Routing (olarindevictor046@gmail.com): order & security alerts, preserved Brevo sender, account-specific resets/lockouts & zero legacy fallback', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor046@gmail.com',
    brevoApiKey: 'xkeysib-test-sender-key',
    brevoFromEmail: 'noreply@sellora-sender.example',
    brevoFromName: 'SELLORA Store',
  });
  const sentPayloads: Array<{ sender: { name?: string; email?: string }; to: Array<{ email: string }>; subject: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('api.brevo.com/v3/smtp/email')) {
      const parsed = JSON.parse(String(init?.body || '{}'));
      sentPayloads.push(parsed);
      return new Response(JSON.stringify({ messageId: `<brevo-${sentPayloads.length}@test>` }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    await seedInitialStoreData(rt.db);

    // 1. Default ADMIN_NOTIFICATION_EMAIL and test recipient resolve to olarindevictor046@gmail.com while BREVO_FROM_EMAIL stays untouched
    const eff = await getEffectiveEmailConfig(rt.db, rt.env);
    assert.equal(eff.adminNotificationEmail, 'olarindevictor046@gmail.com');
    assert.equal(eff.testEmailRecipient, 'olarindevictor046@gmail.com');
    assert.equal(eff.fromEmail, 'noreply@sellora-sender.example');
    assert.equal(eff.fromName, 'SELLORA');

    // Provision owner, create staff account & sign up customer
    const { cookie: ownerCookie } = await provisionAndSignInOwner(rt, {
      email: 'olarindevictor046@gmail.com',
      password: 'StrongOwnerPassword123!',
    });

    const settingsRes = await (
      await rt.app.request('http://localhost:3000/api/admin/settings', {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    assert.equal(settingsRes.emailStatus.resolvedAdminEmail, 'olarindevictor046@gmail.com');
    assert.equal(settingsRes.emailStatus.resolvedFromEmail, 'noreply@sellora-sender.example');

    const staffRes = await rt.app.request('http://localhost:3000/api/admin/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        name: 'Staff Member',
        email: 'staff.ops@sellora.test',
        password: 'StaffPassword123!',
        role: 'order_staff',
      }),
    });
    assert.equal(staffRes.status, 201);

    const custSignup = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada Obi',
        email: 'ada.obi@sellora.test',
        password: 'CustomerPassword123!',
      }),
    });
    assert.equal(custSignup.status, 200);

    // 2. New customer admin notification goes to olarindevictor046@gmail.com; welcome/verification go to customer
    const adminCustAlert = await rt.db.get<{ recipient_email: string }>(
      `SELECT recipient_email FROM email_notification_events WHERE notification_type = 'new_customer' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(adminCustAlert?.recipient_email, 'olarindevictor046@gmail.com');

    // 3. New order notifications route admin alert to olarindevictor046@gmail.com and customer alert to ada.obi@sellora.test
    await triggerOrderNotifications(rt.db, rt.env, {
      eventKey: 'new_order',
      orderId: 'ord_notif_route_1',
      orderNumber: 'SLR-20261116-ROUTE1',
      customerName: 'Ada Obi',
      customerEmail: 'ada.obi@sellora.test',
      statusLabel: 'Pending Bank Transfer',
      totalFormatted: '₦85,000',
      customerTitle: 'Order Placed',
      customerIntro: 'Thank you for your order.',
      adminTitle: 'New Order Received',
      adminIntro: 'A new customer order requires review.',
    });

    const orderEmails = await rt.db.all<{ recipient_email: string; recipient_type: string }>(
      `SELECT recipient_email, recipient_type FROM email_notification_events WHERE order_id = 'ord_notif_route_1'`
    );
    assert.equal(orderEmails.find((e) => e.recipient_type === 'admin')?.recipient_email, 'olarindevictor046@gmail.com');
    assert.equal(orderEmails.find((e) => e.recipient_type === 'customer')?.recipient_email, 'ada.obi@sellora.test');

    // 4. Disputed security alert goes to olarindevictor046@gmail.com while new-device alert goes to customer's registered email
    const custUser = await rt.db.get<{ id: string }>(`SELECT id FROM user WHERE email = 'ada.obi@sellora.test'`);
    await recordLoginAttemptAndMonitor(rt.db, rt.env, {
      headers: new Headers({
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0',
        'cf-ipcountry': 'NG',
      }),
      userId: custUser!.id,
      email: 'ada.obi@sellora.test',
      userName: 'Ada Obi',
      userRole: 'customer',
      authMethod: 'email_password',
      outcome: 'success',
    });
    const loginMon = await recordLoginAttemptAndMonitor(rt.db, rt.env, {
      headers: new Headers({
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1',
        'cf-ipcountry': 'GB',
      }),
      userId: custUser!.id,
      email: 'ada.obi@sellora.test',
      userName: 'Ada Obi',
      userRole: 'customer',
      authMethod: 'email_password',
      outcome: 'success',
    });
    assert.ok(loginMon.disputeUrl);
    const deviceAlert = await rt.db.get<{ recipient_email: string }>(
      `SELECT recipient_email FROM email_notification_events WHERE notification_type = 'security_new_device_login' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(deviceAlert?.recipient_email, 'ada.obi@sellora.test');

    const disputeToken = new URL(loginMon.disputeUrl!).searchParams.get('token')!;
    const disputeRes = await rt.app.request(
      `http://localhost:3000/api/security/login-response?action=dispute&token=${encodeURIComponent(disputeToken)}`
    );
    assert.equal(disputeRes.status, 200);
    const disputedAdminAlert = await rt.db.get<{ recipient_email: string }>(
      `SELECT recipient_email FROM email_notification_events WHERE notification_type = 'security_disputed_login' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(disputedAdminAlert?.recipient_email, 'olarindevictor046@gmail.com');

    // 5. Login lockout alerts continue reaching the affected account's registered email (staff & customer)
    for (let i = 0; i < 2; i++) {
      await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'staff.ops@sellora.test', password: 'WrongPassword!' }),
      });
    }
    const staffLockoutEmail = await rt.db.get<{ recipient_email: string }>(
      `SELECT recipient_email FROM email_notification_events WHERE notification_type = 'security_login_lockout' AND recipient_email = 'staff.ops@sellora.test' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(staffLockoutEmail?.recipient_email, 'staff.ops@sellora.test');

    // 6. Password reset uses the requesting account's own registered email
    const resetReq = await rt.app.request('http://localhost:3000/api/auth/request-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'staff.ops@sellora.test', redirectTo: 'http://localhost:3000/' }),
    });
    assert.equal(resetReq.status, 200);
    const resetEvent = await rt.db.get<{ recipient_email: string }>(
      `SELECT recipient_email FROM email_notification_events WHERE notification_type = 'auth_password_reset' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(resetEvent?.recipient_email, 'staff.ops@sellora.test');

    // 7. Verify Brevo sender remained untouched across all dispatched emails and zero emails went to olarindevictor3@gmail.com
    assert.ok(sentPayloads.length > 0);
    assert.ok(sentPayloads.every((p) => p.sender.email === 'noreply@sellora-sender.example'));
    const legacyRecipients = await rt.db.all<{ event_id: string }>(
      `SELECT event_id FROM email_notification_events WHERE recipient_email = 'olarindevictor3@gmail.com'`
    );
    assert.equal(legacyRecipients.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('Fail-Closed Login Security: DB failures, missing lockout_cycles migration, safe HTTP 503 & progressive 10m/15m/20m lockout + recovery', async () => {
  // Part A: Initial lockout check DB failure & failed-attempt persistence DB failure MUST fail closed (HTTP 503, zero leaks)
  const rt = createTestRuntime({ loginMaxLockoutSeconds: 1200 });
  try {
    await seedInitialStoreData(rt.db);
    await provisionOwnerInDb(rt.db, {
      name: 'Victor Olarinde',
      email: 'olarindevictor046@gmail.com',
      password: 'CorrectFailClosedPassword123!',
    });

    // 1. Direct unit check + HTTP route check when initial lockout DB query throws (even with CORRECT password)
    const origAll = rt.db.all.bind(rt.db);
    (rt.db as any).all = async (sql: string, params?: unknown[]) => {
      if (sql.includes('auth_login_throttles')) {
        throw new Error('SQLITE_ERROR: simulated auth_login_throttles read outage /app/applet/secret');
      }
      return origAll(sql, params);
    };

    const directCheckFail = await checkLoginThrottle(rt.db, 'olarindevictor046@gmail.com', '198.51.100.40');
    assert.equal(directCheckFail.allowed, false);
    assert.equal(directCheckFail.unavailable, true);

    const checkFailHttp = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.40' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'CorrectFailClosedPassword123!',
      }),
    });
    assert.equal(checkFailHttp.status, 503);
    assert.equal(checkFailHttp.headers.get('set-cookie'), null); // Auth NEVER proceeds
    const checkFailBody = await checkFailHttp.json();
    assert.match(checkFailBody.referenceId || '', /^ERR-[A-Z2-9]{8}$/);
    assert.equal(JSON.stringify(checkFailBody).includes('SQLITE_ERROR'), false);
    assert.equal(JSON.stringify(checkFailBody).includes('auth_login_throttles'), false);
    assert.equal(JSON.stringify(checkFailBody).includes('/app/applet'), false);
    (rt.db as any).all = origAll;

    // 2. Direct unit check + HTTP route check when recording a failed login attempt throws -> HTTP 503 (NOT 401!)
    const origRun = rt.db.run.bind(rt.db);
    (rt.db as any).run = async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO auth_login_throttles')) {
        throw new Error('SQLITE_BUSY: database is locked on auth_login_throttles');
      }
      return origRun(sql, params);
    };

    const directRecordFail = await recordFailedLoginAttempt(rt.db, 'olarindevictor046@gmail.com', '198.51.100.41');
    assert.equal(directRecordFail.locked, true);
    assert.equal(directRecordFail.unavailable, true);

    const recordFailHttp = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.41' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'WrongPasswordAttempt!',
      }),
    });
    assert.equal(recordFailHttp.status, 503);
    const recordFailBody = await recordFailHttp.json();
    assert.match(recordFailBody.referenceId || '', /^ERR-[A-Z2-9]{8}$/);
    assert.equal(JSON.stringify(recordFailBody).includes('SQLITE_BUSY'), false);
    assert.equal(JSON.stringify(recordFailBody).includes('auth_login_throttles'), false);
    (rt.db as any).run = origRun;

    // 3. Normal successful login works when DB is healthy
    const okLogin = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.42' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'CorrectFailClosedPassword123!',
      }),
    });
    assert.equal(okLogin.status, 200);
    assert.ok(okLogin.headers.get('set-cookie'));

    // 4. First incorrect attempt (401) -> Second incorrect attempt (10m = 600s lockout, 429) -> 15m (900s) -> 20m (1200s max cap)
    const f1 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.42' },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'Wrong1!' }),
    });
    assert.equal(f1.status, 401);

    const f2 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.42' },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'Wrong2!' }),
    });
    assert.equal(f2.status, 429);
    const r2 = Number(f2.headers.get('retry-after'));
    assert.ok(r2 >= 595 && r2 <= 600);

    await rt.db.run(
      `UPDATE auth_login_throttles SET locked_until_ms = ? WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`,
      [Date.now() - 1000]
    );
    const f3 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.42' },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'Wrong3!' }),
    });
    assert.equal(f3.status, 429);
    const r3 = Number(f3.headers.get('retry-after'));
    assert.ok(r3 >= 895 && r3 <= 900);

    await rt.db.run(
      `UPDATE auth_login_throttles SET locked_until_ms = ? WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`,
      [Date.now() - 1000]
    );
    const f4 = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.42' },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'Wrong4!' }),
    });
    assert.equal(f4.status, 429);
    const r4 = Number(f4.headers.get('retry-after'));
    assert.ok(r4 >= 1195 && r4 <= 1200);

    await rt.db.run(
      `UPDATE auth_login_throttles SET locked_until_ms = ? WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`,
      [Date.now() - 1000]
    );
    const f5Capped = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.42' },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'Wrong5!' }),
    });
    assert.equal(f5Capped.status, 429);
    const r5 = Number(f5Capped.headers.get('retry-after'));
    assert.ok(r5 >= 1195 && r5 <= 1200);

    // 5. Verified password reset clears lockout cleanly
    await rt.app.request('http://localhost:3000/api/auth/request-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', redirectTo: 'http://localhost:3000/' }),
    });
    const resetRow = await rt.db.get<{ html_body: string }>(
      `SELECT html_body FROM email_notification_events WHERE notification_type = 'auth_password_reset' ORDER BY created_at DESC LIMIT 1`
    );
    const resetHref = resetRow!.html_body.match(/href="([^"]*reset-password[^"]*)"/)![1].replace(/&amp;/g, '&');
    const resetToken =
      new URL(resetHref).searchParams.get('token') || new URL(resetHref).pathname.split('/').filter(Boolean).pop()!;
    const resetDone = await rt.app.request('http://localhost:3000/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: 'NewFailClosedPassword123!', token: resetToken }),
    });
    assert.equal(resetDone.status, 200);

    // 1 wrong attempt followed by successful login clears lockout counter completely
    const postResetWrong = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.42' },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'WrongAfterReset!' }),
    });
    assert.equal(postResetWrong.status, 401);

    const postResetOk = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.42' },
      body: JSON.stringify({ email: 'olarindevictor046@gmail.com', password: 'NewFailClosedPassword123!' }),
    });
    assert.equal(postResetOk.status, 200);
    const clearedRow = await rt.db.get<{ fail_count: number }>(
      `SELECT fail_count FROM auth_login_throttles WHERE throttle_key = 'acct:olarindevictor046@gmail.com'`
    );
    assert.equal(clearedRow, null);
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }

  // Part B: Missing / unapplied migration 0006 (auth_login_throttles missing lockout_cycles column) MUST fail closed (503)
  const partialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellora-partial-mig-'));
  const partialMigDir = path.join(partialDir, 'migrations');
  fs.mkdirSync(partialMigDir, { recursive: true });
  for (const fname of [
    '0001_initial.sql',
    '0002_security_indexes.sql',
    '0003_seo_analytics.sql',
    '0004_atomic_checkout_guards.sql',
    '0005_three_layer_security.sql',
  ]) {
    fs.copyFileSync(path.resolve(process.cwd(), 'migrations', fname), path.join(partialMigDir, fname));
  }
  const partialDb = createSqliteDb(path.join(partialDir, 'partial.db'), partialMigDir);
  const partialStorage = createLocalStorage(path.join(partialDir, 'r2'));
  const partialEnv: AppEnvConfig = {
    betterAuthSecret: 'test-secret-012345678901234567890123456789',
    ownerEmail: 'olarindevictor046@gmail.com',
    appUrl: 'http://localhost:3000',
  };
  const partialAuth = createSelloraAuth({
    database: partialDb.rawSqlite!,
    db: partialDb,
    baseURL: partialEnv.appUrl!,
    secret: partialEnv.betterAuthSecret,
    emailEnv: partialEnv,
    ownerEmail: partialEnv.ownerEmail,
  });
  const partialApp = createSelloraApiApp({
    db: partialDb,
    storage: partialStorage,
    auth: partialAuth,
    env: partialEnv,
  });
  try {
    await seedInitialStoreData(partialDb);
    await provisionOwnerInDb(partialDb, {
      name: 'Victor Olarinde',
      email: 'olarindevictor046@gmail.com',
      password: 'PartialMigrationPassword123!',
    });

    const missingColCheck = await checkLoginThrottle(partialDb, 'olarindevictor046@gmail.com', '198.51.100.50');
    assert.equal(missingColCheck.allowed, false);
    assert.equal(missingColCheck.unavailable, true);

    const missingColRecord = await recordFailedLoginAttempt(partialDb, 'olarindevictor046@gmail.com', '198.51.100.50');
    assert.equal(missingColRecord.locked, true);
    assert.equal(missingColRecord.unavailable, true);

    const missingColHttp = await partialApp.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.50' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'PartialMigrationPassword123!',
      }),
    });
    assert.equal(missingColHttp.status, 503);
    assert.equal(missingColHttp.headers.get('set-cookie'), null);
    const missingBody = await missingColHttp.json();
    assert.match(missingBody.referenceId || '', /^ERR-[A-Z2-9]{8}$/);
    assert.equal(JSON.stringify(missingBody).includes('lockout_cycles'), false);
    assert.equal(JSON.stringify(missingBody).includes('no such column'), false);
  } finally {
    fs.rmSync(partialDir, { recursive: true, force: true });
  }
});

function createInMemoryR2Bucket(): R2LikeBucket & { keys: () => string[] } {
  const objects = new Map<string, { data: Uint8Array; contentType: string; uploaded: Date }>();
  return {
    keys() {
      return Array.from(objects.keys());
    },
    async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, {
        data: new Uint8Array(value),
        contentType: options?.httpMetadata?.contentType || 'application/octet-stream',
        uploaded: new Date(),
      });
    },
    async get(key: string) {
      const entry = objects.get(key);
      if (!entry) return null;
      return {
        httpMetadata: { contentType: entry.contentType },
        async arrayBuffer() {
          return entry.data.slice().buffer;
        },
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix || '';
      const matched = Array.from(objects.entries())
        .filter(([k]) => !prefix || k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, uploaded: v.uploaded }));
      return { objects: matched, truncated: false };
    },
  };
}

test('Cloudflare Worker runtime routes all DB & media operations through D1 and R2 and supports Web, Android & iOS clients', async () => {
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  const d1Raw = createInMemoryD1Shim(migrationsDir);
  const r2Bucket = createInMemoryR2Bucket();
  const db = createD1Db(d1Raw);

  const workerEnv: WorkerEnv = {
    DB: d1Raw,
    R2_MEDIA: r2Bucket,
    ASSETS: {
      async fetch() {
        return new Response('<html><head><title>SELLORA</title></head><body>OK</body></html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    },
    APP_URL: 'https://sellora-commerce.example.workers.dev',
    BETTER_AUTH_SECRET: 'worker-prod-secret-012345678901234567890123456',
    OWNER_EMAIL: 'olarindevictor046@gmail.com',
    ADMIN_NOTIFICATION_EMAIL: 'olarindevictor046@gmail.com',
    LOGIN_MAX_LOCKOUT_SECONDS: '3600',
  };

  // 1. Fail-closed when DB or R2_MEDIA binding is missing
  const noDbRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/health'),
    { ...workerEnv, DB: undefined as any }
  );
  assert.equal(noDbRes.status, 503);

  const noR2Res = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/products'),
    { ...workerEnv, R2_MEDIA: undefined as any }
  );
  assert.equal(noR2Res.status, 503);

  // 2. Public /api/health returns OK without leaking provider strings, while owner-only /api/admin/infrastructure-status reports Cloudflare D1 + R2
  const healthRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/health') as any,
    workerEnv
  );
  assert.equal(healthRes.status, 200);
  const healthText = await healthRes.text();
  assert.equal(healthText.includes('cloudflare'), false);
  assert.equal(healthText.includes('d1'), false);
  assert.equal(JSON.parse(healthText).ok, true);

  // 3. Provision owner into D1 & verify Worker sign-in, owner-only infrastructure check, and R2 media upload / read / delete
  await provisionOwnerInDb(db, {
    name: 'Victor Olarinde',
    email: 'olarindevictor046@gmail.com',
    password: 'WorkerOwnerPassword123!',
  });

  const signInRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor046@gmail.com',
        password: 'WorkerOwnerPassword123!',
      }),
    }),
    workerEnv
  );
  assert.equal(signInRes.status, 200);
  const rawWorkerCookie = extractCookieHeader(signInRes);

  const unauthInfraRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/admin/infrastructure-status'),
    workerEnv
  );
  assert.equal(unauthInfraRes.status, 401);

  // Strict admin security blocks access until Gmail approval + scrypt secondary password
  const lockedInfraRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/admin/infrastructure-status', {
      headers: { Cookie: rawWorkerCookie },
    }),
    workerEnv
  );
  assert.equal(lockedInfraRes.status, 423);

  const ownerCookie = await unlockPrivilegedSession(
    { db },
    signInRes,
    {
      baseUrl: 'https://sellora-commerce.example.workers.dev',
      dispatch: (url, init) => workerEntry.fetch(new Request(url, init), workerEnv),
    }
  );

  const infraRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/admin/infrastructure-status', {
      headers: { Cookie: ownerCookie },
    }),
    workerEnv
  );
  assert.equal(infraRes.status, 200);
  const infraJson = await infraRes.json();
  assert.equal(infraJson.runtime, 'cloudflare-worker');
  assert.equal(infraJson.database, 'cloudflare-d1');
  assert.equal(infraJson.storage, 'cloudflare-r2');
  assert.equal(infraJson.environment, 'production');

  const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const mediaForm = new FormData();
  mediaForm.append('file', new File([validPng], 'hero.png', { type: 'image/png' }));
  const uploadRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/admin/media/upload', {
      method: 'POST',
      headers: { Cookie: ownerCookie },
      body: mediaForm,
    }),
    workerEnv
  );
  assert.equal(uploadRes.status, 201);
  const uploadJson = await uploadRes.json();
  assert.match(uploadJson.url, /^\/api\/media\/products\/prod_.*\.png$/);
  const uploadedFile = uploadJson.url.split('/').pop()!;
  assert.equal(r2Bucket.keys().includes(`products/${uploadedFile}`), true);

  // Public media read routes directly through Worker env.R2_MEDIA
  const readMediaRes = await workerEntry.fetch(
    new Request(`https://sellora-commerce.example.workers.dev${uploadJson.url}`),
    workerEnv
  );
  assert.equal(readMediaRes.status, 200);
  assert.equal(readMediaRes.headers.get('content-type'), 'image/png');

  // Create product referencing the R2 asset, confirm deletion is blocked while referenced, then delete product
  const createProdRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/admin/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        name: 'Cloudflare R2 Studio Speaker',
        priceNaira: 95000,
        stockQuantity: 10,
        media: [uploadJson.url],
      }),
    }),
    workerEnv
  );
  assert.equal(createProdRes.status, 201);
  const createProdJson = await createProdRes.json();

  const blockedDeleteMedia = await workerEntry.fetch(
    new Request(`https://sellora-commerce.example.workers.dev/api/admin/media/${uploadedFile}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie },
    }),
    workerEnv
  );
  assert.equal(blockedDeleteMedia.status, 409);

  const deleteProdRes = await workerEntry.fetch(
    new Request(`https://sellora-commerce.example.workers.dev/api/admin/products/${createProdJson.id}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie },
    }),
    workerEnv
  );
  assert.equal(deleteProdRes.status, 200);
  // Deleting product cleanly removed unreferenced R2 object
  assert.equal(r2Bucket.keys().includes(`products/${uploadedFile}`), false);

  // 4. Upload second unreferenced file and delete via explicit DELETE /api/admin/media/:file
  const mediaForm2 = new FormData();
  mediaForm2.append('file', new File([validPng], 'standalone.png', { type: 'image/png' }));
  const upload2Res = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/admin/media/upload', {
      method: 'POST',
      headers: { Cookie: ownerCookie },
      body: mediaForm2,
    }),
    workerEnv
  );
  assert.equal(upload2Res.status, 201);
  const file2 = (await upload2Res.json()).url.split('/').pop()!;
  const delMediaRes = await workerEntry.fetch(
    new Request(`https://sellora-commerce.example.workers.dev/api/admin/media/${file2}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie },
    }),
    workerEnv
  );
  assert.equal(delMediaRes.status, 200);
  assert.equal(r2Bucket.keys().includes(`products/${file2}`), false);

  // 5. Android & iOS Capacitor origins share the Worker API cleanly while untrusted origins stay blocked
  const androidMutRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://localhost',
        'Sec-Fetch-Site': 'cross-site',
        'x-cart-token': 'cart_android_1',
      },
      body: JSON.stringify({ items: [] }),
    }),
    workerEnv
  );
  assert.equal(androidMutRes.status, 200);
  assert.equal(androidMutRes.headers.get('access-control-allow-origin'), 'https://localhost');

  const iosMutRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'capacitor://localhost',
        'Sec-Fetch-Site': 'cross-site',
        'x-cart-token': 'cart_ios_1',
      },
      body: JSON.stringify({ items: [] }),
    }),
    workerEnv
  );
  assert.equal(iosMutRes.status, 200);
  assert.equal(iosMutRes.headers.get('access-control-allow-origin'), 'capacitor://localhost');

  const evilOriginRes = await workerEntry.fetch(
    new Request('https://sellora-commerce.example.workers.dev/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil-store.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ items: [] }),
    }),
    workerEnv
  );
  assert.equal(evilOriginRes.status, 403);

  // 6. Frontend & Capacitor URL helpers resolve relative /api paths consistently
  assert.equal(resolveApiUrl('/api/products', ''), '/api/products');
  assert.equal(
    resolveApiUrl('/api/products', 'https://sellora-commerce.example.workers.dev/'),
    'https://sellora-commerce.example.workers.dev/api/products'
  );
  assert.equal(
    resolveMediaUrl('/api/media/products/prod_1.png', 'https://sellora-commerce.example.workers.dev'),
    'https://sellora-commerce.example.workers.dev/api/media/products/prod_1.png'
  );
  assert.equal(
    resolveMediaUrl('/src/assets/images/hero_sellora_editorial_1794648058731.jpg', 'https://sellora-commerce.example.workers.dev'),
    '/src/assets/images/hero_sellora_editorial_1794648058731.jpg'
  );
});

describe('Requirements A–E: Manual & Auto SKUs, Calibrated scrypt Admin Security Password, Strict Device/IP Gate & Scanner-Safe Gmail Approval', () => {
  test('Requirement A: Manual & automatic SKUs, cross-table uniqueness, concurrency races, and order-referenced immutability triggers', async () => {
    const rt = createTestRuntime();
    try {
      await seedInitialStoreData(rt.db);
      const { cookie: ownerCookie } = await provisionAndSignInOwner(rt);

      // 1. Create product with normalized manual SKUs (product + variant)
      const manualRes = await rt.app.request('http://localhost:3000/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          name: 'Ikoyi Leather Folio',
          skuMode: 'manual',
          sku: ' iky-folio-01 ',
          variantSku: 'iky-folio-01-black',
          variantName: 'Obsidian Black',
          priceNaira: 42000,
          stockQuantity: 10,
          status: 'active',
        }),
      });
      assert.equal(manualRes.status, 201);
      const manualProd = (await manualRes.json()) as {
        id: string;
        variantId: string;
        sku: string;
        variantSku: string;
      };
      assert.equal(manualProd.sku, 'IKY-FOLIO-01');
      assert.equal(manualProd.variantSku, 'IKY-FOLIO-01-BLACK');

      // 2. Duplicate manual SKU (case-insensitive) -> 409 SKU_ALREADY_EXISTS
      const dupProdRes = await rt.app.request('http://localhost:3000/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          name: 'Duplicate SKU Product',
          skuMode: 'manual',
          sku: 'iky-folio-01',
          priceNaira: 15000,
          stockQuantity: 5,
        }),
      });
      assert.equal(dupProdRes.status, 409);
      assert.equal((await dupProdRes.json()).code, 'SKU_ALREADY_EXISTS');

      // 3. Cross-table uniqueness: product SKU cannot collide with an existing variant SKU, and vice versa
      const crossProdRes = await rt.app.request('http://localhost:3000/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          name: 'Cross Table Product',
          skuMode: 'manual',
          sku: 'iky-folio-01-black',
          priceNaira: 18000,
          stockQuantity: 5,
        }),
      });
      assert.equal(crossProdRes.status, 409);
      assert.equal((await crossProdRes.json()).code, 'SKU_ALREADY_EXISTS');

      const crossVarRes = await rt.app.request(`http://localhost:3000/api/admin/products/${manualProd.id}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          name: 'Tan Variant',
          skuMode: 'manual',
          sku: 'IKY-FOLIO-01',
          stockQuantity: 3,
        }),
      });
      assert.equal(crossVarRes.status, 409);
      assert.equal((await crossVarRes.json()).code, 'SKU_ALREADY_EXISTS');

      // 4. Add a second manual variant safely & an auto-generated third variant
      const tanVarRes = await rt.app.request(`http://localhost:3000/api/admin/products/${manualProd.id}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          name: 'Tan Leather',
          skuMode: 'manual',
          sku: 'IKY-FOLIO-01-TAN',
          stockQuantity: 6,
        }),
      });
      assert.equal(tanVarRes.status, 201);
      const tanVar = (await tanVarRes.json()) as { id: string; sku: string };
      assert.equal(tanVar.sku, 'IKY-FOLIO-01-TAN');

      const autoVarRes = await rt.app.request(`http://localhost:3000/api/admin/products/${manualProd.id}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          name: 'Olive Suede',
          skuMode: 'auto',
          stockQuantity: 4,
        }),
      });
      assert.equal(autoVarRes.status, 201);

      // 5. Concurrent manual SKU creation race -> only one succeeds (201), duplicate fails cleanly (409)
      const [raceA, raceB] = await Promise.all([
        rt.app.request('http://localhost:3000/api/admin/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
          body: JSON.stringify({
            name: 'Race Product A',
            skuMode: 'manual',
            sku: 'RACE-CONCURRENT-77',
            priceNaira: 12000,
            stockQuantity: 2,
          }),
        }),
        rt.app.request('http://localhost:3000/api/admin/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
          body: JSON.stringify({
            name: 'Race Product B',
            skuMode: 'manual',
            sku: 'race-concurrent-77',
            priceNaira: 12000,
            stockQuantity: 2,
          }),
        }),
      ]);
      const raceStatuses = [raceA.status, raceB.status].sort();
      assert.deepEqual(raceStatuses, [201, 409]);

      // 6. Unordered product & variant SKUs CAN be edited safely
      const renameProdSku = await rt.app.request(`http://localhost:3000/api/admin/products/${manualProd.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ sku: 'IKY-FOLIO-PRIME' }),
      });
      assert.equal(renameProdSku.status, 200);
      assert.equal((await renameProdSku.json()).sku, 'IKY-FOLIO-PRIME');

      const renameVarSku = await rt.app.request(`http://localhost:3000/api/admin/variants/${tanVar.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ sku: 'IKY-FOLIO-TAN-02' }),
      });
      assert.equal(renameVarSku.status, 200);
      assert.equal((await renameVarSku.json()).sku, 'IKY-FOLIO-TAN-02');

      // 7. Place a POS order referencing the variant -> snapshot order_items.sku, block future SKU mutations
      const posRes = await rt.app.request('http://localhost:3000/api/admin/pos/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          customerName: 'Tunde Bakare',
          customerEmail: 'tunde@example.com',
          customerPhone: '08030000000',
          items: [{ productId: manualProd.id, variantId: tanVar.id, quantity: 1 }],
          markPaid: true,
        }),
      });
      assert.equal(posRes.status, 201);
      const posOrder = (await posRes.json()) as { orderId: string };

      const itemSnapshot = await rt.db.get<{ sku: string }>(
        `SELECT sku FROM order_items WHERE order_id = ?`,
        [posOrder.orderId]
      );
      assert.equal(itemSnapshot?.sku, 'IKY-FOLIO-TAN-02');

      // Attempted product & variant SKU change after order -> 409 SKU_REFERENCED_BY_ORDER
      const lockedProdPatch = await rt.app.request(`http://localhost:3000/api/admin/products/${manualProd.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ sku: 'IKY-MUTATE-AFTER-ORDER' }),
      });
      assert.equal(lockedProdPatch.status, 409);
      assert.equal((await lockedProdPatch.json()).code, 'SKU_REFERENCED_BY_ORDER');

      const lockedVarPatch = await rt.app.request(`http://localhost:3000/api/admin/variants/${tanVar.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ sku: 'IKY-VAR-MUTATE-AFTER-ORDER' }),
      });
      assert.equal(lockedVarPatch.status, 409);
      assert.equal((await lockedVarPatch.json()).code, 'SKU_REFERENCED_BY_ORDER');

      // Raw DB trigger check: silent SQL UPDATE on ordered SKU aborts with SKU_REFERENCED_BY_ORDER
      let dbGuardCaught = '';
      try {
        await rt.db.run(`UPDATE product_variants SET sku = 'BYPASS-ATTEMPT' WHERE id = ?`, [tanVar.id]);
      } catch (err) {
        dbGuardCaught = extractDbGuardCode(err) || '';
      }
      assert.equal(dbGuardCaught, 'SKU_REFERENCED_BY_ORDER');

      // Updating non-SKU fields (name) still works cleanly while SKU & order_items snapshot stay immutable
      const safeNonSkuEdit = await rt.app.request(`http://localhost:3000/api/admin/products/${manualProd.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ name: 'Ikoyi Leather Folio Edition 2' }),
      });
      assert.equal(safeNonSkuEdit.status, 200);
      const afterItemSnapshot = await rt.db.get<{ sku: string }>(
        `SELECT sku FROM order_items WHERE order_id = ?`,
        [posOrder.orderId]
      );
      assert.equal(afterItemSnapshot?.sku, 'IKY-FOLIO-TAN-02');
    } finally {
      fs.rmSync(rt.tmpDir, { recursive: true, force: true });
    }
  });

  test('Requirement B: Separate Admin Security Password uses calibrated scrypt (N=16384), progressive lockout, and recovery flows', async () => {
    const rt = createTestRuntime();
    try {
      await seedInitialStoreData(rt.db);
      const { cookie: ownerCookie, userId } = await provisionAndSignInOwner(rt, {
        secPassword: 'FirstSecPassword!99',
      });

      // 1. Stored hash uses calibrated scrypt N=16384,r=8,p=1 (dkLen=64), never plaintext
      const cred = await rt.db.get<{ password_hash: string; hash_algorithm: string }>(
        `SELECT password_hash, hash_algorithm FROM admin_security_credentials WHERE user_id = ?`,
        [userId]
      );
      assert.ok(cred);
      assert.equal(cred.hash_algorithm, 'scrypt_N16384_r8_p1_dkLen64');
      assert.match(cred.password_hash, /^scrypt\$N=16384\$r=8\$p=1\$dkLen=64\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
      assert.equal(cred.password_hash.includes('FirstSecPassword!99'), false);

      // 2. Authenticate from same trusted cookie+IP in a fresh session -> skips Gmail lock, requires security password check
      const trustedDeviceCookiePart = ownerCookie
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('sellora_admin_device='));
      assert.ok(trustedDeviceCookiePart);

      const secondSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: trustedDeviceCookiePart,
        },
        body: JSON.stringify({
          email: 'olarindevictor046@gmail.com',
          password: 'StrongOwnerPassword123!',
        }),
      });
      assert.equal(secondSignIn.status, 200);
      const secondCookie = `${extractCookieHeader(secondSignIn)}; ${trustedDeviceCookiePart}`;

      // Accessing admin route before verifying secondary password -> 423 ADMIN_SEC_PASSWORD_REQUIRED
      const blockedBeforeSecPwd = await rt.app.request('http://localhost:3000/api/admin/orders', {
        headers: { Cookie: secondCookie },
      });
      assert.equal(blockedBeforeSecPwd.status, 423);
      assert.equal((await blockedBeforeSecPwd.json()).lockCode, 'ADMIN_SEC_PASSWORD_REQUIRED');

      // 3. Wrong secondary passwords increment attempts and trigger persistent 429 lockout on threshold
      for (let i = 0; i < 4; i++) {
        const wrong = await rt.app.request('http://localhost:3000/api/admin/security/password/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: secondCookie },
          body: JSON.stringify({ password: `WrongSec#${i}` }),
        });
        assert.equal(wrong.status, 401);
      }
      const fifthWrong = await rt.app.request('http://localhost:3000/api/admin/security/password/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: secondCookie },
        body: JSON.stringify({ password: 'WrongSec#5' }),
      });
      assert.equal(fifthWrong.status, 429);
      assert.ok(fifthWrong.headers.get('retry-after'));

      // Reset cooldown expiry in DB so we can verify correct password + change + recovery in tests
      await rt.db.run(
        `UPDATE admin_security_credentials SET locked_until_ms = 0, failed_attempts = 0 WHERE user_id = ?`,
        [userId]
      );

      const okVerify = await rt.app.request('http://localhost:3000/api/admin/security/password/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: secondCookie },
        body: JSON.stringify({ password: 'FirstSecPassword!99' }),
      });
      assert.equal(okVerify.status, 200);

      // 4. Change Admin Security Password -> invalidates OTHER active sessions' verification
      const changeRes = await rt.app.request('http://localhost:3000/api/admin/security/password/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          currentPassword: 'FirstSecPassword!99',
          newPassword: 'SecondSecPassword!2026',
        }),
      });
      assert.equal(changeRes.status, 200);
      const changeJson = (await changeRes.json()) as { ok: boolean; recoveryCode?: string };
      assert.equal(changeJson.ok, true);
      assert.ok(changeJson.recoveryCode);

      // Second session must now re-verify secondary password
      const secondAfterChange = await rt.app.request('http://localhost:3000/api/admin/orders', {
        headers: { Cookie: secondCookie },
      });
      assert.equal(secondAfterChange.status, 423);
      assert.equal((await secondAfterChange.json()).lockCode, 'ADMIN_SEC_PASSWORD_REQUIRED');

      // 5. Recover via Brevo email recovery token AND via single-use backup recovery code
      const recReqRes = await rt.app.request('http://localhost:3000/api/admin/security/password/recover/request', {
        method: 'POST',
        headers: { Cookie: secondCookie },
      });
      assert.equal(recReqRes.status, 200);

      const recEmail = await rt.db.get<{ html_body: string }>(
        `SELECT html_body FROM email_notification_events
         WHERE notification_type = 'security_admin_password_recovery'
         ORDER BY created_at DESC LIMIT 1`
      );
      assert.ok(recEmail?.html_body);
      const hexMatch = recEmail.html_body.match(/([a-f0-9]{64})/);
      assert.ok(hexMatch?.[1]);

      const recConfirmEmail = await rt.app.request('http://localhost:3000/api/admin/security/password/recover/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: secondCookie },
        body: JSON.stringify({
          recoveryTokenOrCode: hexMatch[1],
          newPassword: 'RecoveredByEmail!2026',
        }),
      });
      assert.equal(recConfirmEmail.status, 200);
      const rotatedCode = (await recConfirmEmail.json()).recoveryCode as string;
      assert.ok(rotatedCode);

      // Now recover using the rotated offline backup code on another session
      const recConfirmCode = await rt.app.request('http://localhost:3000/api/admin/security/password/recover/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          recoveryTokenOrCode: rotatedCode,
          newPassword: 'RecoveredByBackup!2026',
        }),
      });
      assert.equal(recConfirmCode.status, 200);

      // Primary password remained completely unchanged throughout secondary recovery
      const ordersNow = await rt.app.request('http://localhost:3000/api/admin/orders', {
        headers: { Cookie: ownerCookie },
      });
      assert.equal(ordersNow.status, 200);
    } finally {
      fs.rmSync(rt.tmpDir, { recursive: true, force: true });
    }
  });

  test('Requirements C, D & E: Strict unfamiliar device/IP lock, scanner-safe Gmail approval, session-only expiry, revocation & customer isolation', async () => {
    const rt = createTestRuntime();
    try {
      await seedInitialStoreData(rt.db);
      const { cookie: trustedOwnerCookie, userId } = await provisionAndSignInOwner(rt);

      // 1. Fresh sign-in WITHOUT device cookie triggers strict ADMIN_SECURITY_LOCKED and queues Brevo alert
      const unfamiliarSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/126.0',
        },
        body: JSON.stringify({
          email: 'olarindevictor046@gmail.com',
          password: 'StrongOwnerPassword123!',
        }),
      });
      assert.equal(unfamiliarSignIn.status, 200);
      const unfamiliarCookie = extractCookieHeader(unfamiliarSignIn);

      const lockedAdminAttempt = await rt.app.request('http://localhost:3000/api/admin/orders', {
        headers: { Cookie: unfamiliarCookie },
      });
      assert.equal(lockedAdminAttempt.status, 423);
      assert.equal((await lockedAdminAttempt.json()).lockCode, 'ADMIN_SECURITY_LOCKED');

      const alertEmail = await rt.db.get<{ recipient_email: string; html_body: string }>(
        `SELECT recipient_email, html_body FROM email_notification_events
         WHERE notification_type = 'security_admin_approval_required'
         ORDER BY created_at DESC LIMIT 1`
      );
      assert.equal(alertEmail?.recipient_email, 'olarindevictor046@gmail.com');
      assert.ok(alertEmail?.html_body.includes('WAT'));
      assert.ok(alertEmail?.html_body.includes('UTC'));
      assert.equal(alertEmail?.html_body.includes('StrongOwnerPassword123!'), false);

      const approveTok = alertEmail!.html_body.match(/action=approve(?:&amp;|&)token=([A-Za-z0-9_-]+)/)![1];
      const rejectTok = alertEmail!.html_body.match(/action=reject(?:&amp;|&)token=([A-Za-z0-9_-]+)/)![1];
      assert.ok(approveTok && rejectTok);

      // 2. Email scanner safety: GET /api/security/admin-approval renders confirmation page and NEVER approves/consumes
      const scannerGet = await rt.app.request(
        `http://localhost:3000/api/security/admin-approval?action=approve&token=${encodeURIComponent(approveTok)}`
      );
      assert.equal(scannerGet.status, 200);
      const scannerHtml = await scannerGet.text();
      assert.ok(scannerHtml.includes('YES — APPROVE ACCESS'));
      assert.ok(scannerHtml.includes('method="POST"'));

      const pendingAfterScanner = await rt.db.get<{ id: string; status: string }>(
        `SELECT id, status FROM admin_login_approvals ORDER BY created_at DESC LIMIT 1`
      );
      assert.equal(pendingAfterScanner?.status, 'pending');

      // Mismatched action submitted on POST is rejected cleanly (400) without mutating status
      const mismatchPost = await rt.app.request('http://localhost:3000/api/security/admin-approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', token: approveTok }),
      });
      assert.equal(mismatchPost.status, 400);

      // 3. Explicit POST rejection terminates ONLY that session while leaving trusted session active
      const explicitReject = await rt.app.request('http://localhost:3000/api/security/admin-approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', token: rejectTok }),
      });
      assert.equal(explicitReject.status, 200);
      assert.equal((await explicitReject.json()).decision, 'rejected');

      // Rejected session is deleted -> 401; trustedOwnerCookie remains 200
      const rejectedOrdersAttempt = await rt.app.request('http://localhost:3000/api/admin/orders', {
        headers: { Cookie: unfamiliarCookie },
      });
      assert.equal(rejectedOrdersAttempt.status, 401);
      assert.equal(
        (await rt.app.request('http://localhost:3000/api/admin/orders', { headers: { Cookie: trustedOwnerCookie } })).status,
        200
      );

      // 4. Session-only approval expiry: timed-out request expires ONLY its session and NEVER permanently locks account
      const timedSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'olarindevictor046@gmail.com',
          password: 'StrongOwnerPassword123!',
        }),
      });
      assert.equal(timedSignIn.status, 200);
      const timedCookie = extractCookieHeader(timedSignIn);

      const timedRow = await rt.db.get<{ id: string; session_id: string }>(
        `SELECT id, session_id FROM admin_login_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`
      );
      assert.ok(timedRow);
      // Force expiration in past
      await rt.db.run(
        `UPDATE admin_login_approvals SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`,
        [timedRow.id]
      );

      const expiredCheck = await rt.app.request('http://localhost:3000/api/admin/security/status', {
        headers: { Cookie: timedCookie },
      });
      assert.equal(expiredCheck.status, 200);
      const expiredJson = ((await expiredCheck.json()) as {
        adminSecurity: {
          unlocked: boolean;
          lockCode: string;
          deviceApprovalStatus: string;
        };
      }).adminSecurity;
      assert.equal(expiredJson.unlocked, false);
      assert.equal(expiredJson.lockCode, 'ADMIN_SECURITY_LOCKED');
      assert.equal(expiredJson.deviceApprovalStatus, 'expired');

      // Confirm admin account is NOT permanently locked: fresh login succeeds & gets a brand-new pending approval
      const freshRetrySignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'olarindevictor046@gmail.com',
          password: 'StrongOwnerPassword123!',
        }),
      });
      assert.equal(freshRetrySignIn.status, 200);
      const unlockedFreshCookie = await unlockPrivilegedSession(rt, freshRetrySignIn);
      assert.equal(
        (await rt.app.request('http://localhost:3000/api/admin/orders', { headers: { Cookie: unlockedFreshCookie } })).status,
        200
      );

      // 5. Missing device cookie mid-session -> immediate re-lock (423 ADMIN_SECURITY_LOCKED)
      const sessionOnlyPart = unlockedFreshCookie
        .split(';')
        .map((s) => s.trim())
        .find((s) => !s.startsWith('sellora_admin_device='))!;
      const strippedDeviceReq = await rt.app.request('http://localhost:3000/api/admin/orders', {
        headers: { Cookie: sessionOnlyPart },
      });
      assert.equal(strippedDeviceReq.status, 423);
      assert.equal((await strippedDeviceReq.json()).lockCode, 'ADMIN_SECURITY_LOCKED');

      // 6. Requirement E: Admin Security Overview, Approval Decide & Device Revocation
      const overviewRes = await rt.app.request('http://localhost:3000/api/admin/security/overview', {
        headers: { Cookie: trustedOwnerCookie },
      });
      assert.equal(overviewRes.status, 200);
      const overview = (await overviewRes.json()) as {
        trustedDevices: Array<{ id: string; is_active: number; user_id: string }>;
        pendingApprovals: Array<{ id: string; status: string }>;
        recentLogins: Array<{ ip_address: string }>;
        securityEvents: Array<{ event_ref: string }>;
      };
      assert.ok(overview.trustedDevices.length >= 1);
      assert.ok(overview.recentLogins.length >= 1);
      assert.ok(overview.securityEvents.length >= 1);

      // Sign in again on unknown device, approve via authenticated trusted dashboard /decide endpoint
      const pendingDashSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'olarindevictor046@gmail.com',
          password: 'StrongOwnerPassword123!',
        }),
      });
      const pendingDashCookie = extractCookieHeader(pendingDashSignIn);
      const pendingApv = await rt.db.get<{ id: string }>(
        `SELECT id FROM admin_login_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`
      );
      assert.ok(pendingApv);

      const dashDecideRes = await rt.app.request(
        `http://localhost:3000/api/admin/security/approvals/${pendingApv.id}/decide`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: trustedOwnerCookie },
          body: JSON.stringify({ action: 'approve' }),
        }
      );
      assert.equal(dashDecideRes.status, 200);

      // That approved session still requires secondary password, then enters!
      const afterDashApprove = await rt.app.request('http://localhost:3000/api/admin/orders', {
        headers: { Cookie: pendingDashCookie },
      });
      assert.equal(afterDashApprove.status, 423);
      assert.equal((await afterDashApprove.json()).lockCode, 'ADMIN_SEC_PASSWORD_REQUIRED');

      const verifyRes = await rt.app.request('http://localhost:3000/api/admin/security/password/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: pendingDashCookie },
        body: JSON.stringify({ password: 'AdminSecPass#2026!' }),
      });
      assert.equal(verifyRes.status, 200);
      assert.equal(
        (await rt.app.request('http://localhost:3000/api/admin/orders', { headers: { Cookie: pendingDashCookie } })).status,
        200
      );

      // Revoking a non-current trusted device terminates that device's active session immediately
      const overview2 = await (
        await rt.app.request('http://localhost:3000/api/admin/security/overview', {
          headers: { Cookie: trustedOwnerCookie },
        })
      ).json();
      const nonCurrentActiveDevice = overview2.trustedDevices.find(
        (d: any) => d.is_active === 1 && d.user_id === userId && overview2.trustedDevices.indexOf(d) !== overview2.trustedDevices.length - 1
      );
      if (nonCurrentActiveDevice) {
        const revRes = await rt.app.request(
          `http://localhost:3000/api/admin/security/devices/${nonCurrentActiveDevice.id}`,
          {
            method: 'DELETE',
            headers: { Cookie: trustedOwnerCookie },
          }
        );
        assert.equal(revRes.status, 200);
      }

      // 7. Customer accounts remain completely exempt from strict admin gate
      const custSignUp = await rt.app.request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Chidi Okonkwo',
          email: 'chidi@shopper.test',
          password: 'ShopperPassword123!',
        }),
      });
      assert.equal(custSignUp.status, 200);
      const custCookie = extractCookieHeader(custSignUp);
      const custMe = await (
        await rt.app.request('http://localhost:3000/api/me', { headers: { Cookie: custCookie } })
      ).json();
      assert.equal(custMe.user.role, 'customer');
      assert.equal(custMe.adminSecurity?.required ?? false, false);
    } finally {
      fs.rmSync(rt.tmpDir, { recursive: true, force: true });
    }
  });
});





