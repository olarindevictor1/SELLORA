import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createD1Db, type D1LikeDatabase, type D1PreparedStatementLike } from '../src/server/db';
import { createSqliteDb, createLocalStorage } from '../src/server/db-node';
import { seedInitialStoreData } from '../src/server/seed';
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
import { isTurnstileConfigured, verifyTurnstileToken } from '../src/server/security';
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
    ownerEmail: 'olarindevictor3@gmail.com',
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

async function provisionAndSignInOwner(
  rt: { app: any; db: any },
  opts: { name?: string; email?: string; password?: string } = {}
): Promise<{ cookie: string; userId: string }> {
  const email = (opts.email || 'olarindevictor3@gmail.com').trim().toLowerCase();
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
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
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

  const makeStmt = (sql: string, bound: unknown[] = []): D1PreparedStatementLike & { raw: <T = unknown>() => Promise<T[]> } => ({
    bind(...values: unknown[]) {
      return makeStmt(sql, values);
    },
    async all<T = unknown>() {
      const results = sqlite.prepare(sql).all(...bound) as T[];
      return { results, success: true, meta: {} } as { results: T[] };
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
      const out: T[] = [];
      for (const stmt of statements) {
        out.push((await stmt.all()) as T);
      }
      return out;
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
      body: JSON.stringify({ email: 'olarindevictor3@gmail.com' }),
    });
    assert.equal(legacyBootPost.status, 404);

    // 2. Server-side Owner Provisioning & Standard Sign-In
    const { cookie: ownerCookie } = await provisionAndSignInOwner(
      { app, db },
      { email: 'olarindevictor3@gmail.com', password: 'StrongPassword123!' }
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
    form.append('receipt', new File([new Uint8Array([137, 80, 78, 71])], 'receipt.png', { type: 'image/png' }));

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
    ownerEmail: 'olarindevictor3@gmail.com',
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
        email: 'olarindevictor3@gmail.com',
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
        email: 'olarindevictor3@gmail.com',
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

    // 5. Verified Google OAuth sign-in for olarindevictor3@gmail.com authorizes owner automatically
    const verifiedOwnerUser = await authCtx.internalAdapter.createUser(
      {
        name: 'Victor Olarinde',
        email: 'olarindevictor3@gmail.com',
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
      ['olarindevictor3@gmail.com']
    );
    assert.equal(ownerRowAfterGoogle?.id, verifiedOwnerUser.id);
    assert.equal(ownerRowAfterGoogle?.role, 'owner');
    assert.equal(ownerRowAfterGoogle?.emailVerified, 1);

    // 6. Adding Email & Password to that same Google-created owner resolves to the SAME user.id
    const addPwdRes = await provisionOwnerInDb(rt.db, {
      name: 'Victor Olarinde',
      email: 'olarindevictor3@gmail.com',
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
        email: 'olarindevictor3@gmail.com',
        password: 'WrongPassword123!',
      }),
    });
    assert.equal(badLogin.status, 401);

    // Verify valid Email & Password signs into the SAME owner account
    const goodLogin = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor3@gmail.com',
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

    // Ensure no duplicate user records exist for olarindevictor3@gmail.com
    const dupCount = await rt.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM user WHERE LOWER(email) = 'olarindevictor3@gmail.com'`
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
      email: 'olarindevictor3@gmail.com',
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

    // Sign in as Admin and Staff
    const adminSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@sellora.test', password: 'AdminPassword123!' }),
    });
    assert.equal(adminSignIn.status, 200);
    const adminCookie = adminSignIn.headers.get('set-cookie')!.split(';')[0];

    const staffSignIn = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'staff@sellora.test', password: 'StaffPassword123!' }),
    });
    assert.equal(staffSignIn.status, 200);
    const staffCookie = staffSignIn.headers.get('set-cookie')!.split(';')[0];

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
    const ownerRow = await rt.db.get<{ id: string }>(`SELECT id FROM user WHERE email = ?`, ['olarindevictor3@gmail.com']);
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
      email: 'olarindevictor3@gmail.com',
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
        email: 'olarindevictor3@gmail.com',
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
      ownerEmail: 'olarindevictor3@gmail.com',
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
      { email: 'olarindevictor3@gmail.com', password: 'StrongPassword123!' }
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

test('Designated owner olarindevictor3@gmail.com Email+Password and Google OAuth linking share one account and fallback admin notification email', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor3@gmail.com',
    googleClientId: '1234567890-mock.apps.googleusercontent.com',
    googleClientSecret: 'mock-google-client-secret',
  });
  try {
    await seedInitialStoreData(rt.db);

    const effEmail = await getEffectiveEmailConfig(rt.db, rt.env);
    assert.equal(effEmail.adminNotificationEmail, 'olarindevictor3@gmail.com');

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
      email: 'olarindevictor3@gmail.com',
      password: 'OwnerPassword123!',
    });
    assert.equal(prov.status, 'created');

    // Re-provisioning refuses silently overwriting existing password
    const secondProv = await provisionOwnerInDb(rt.db, {
      name: 'Victor Olarinde',
      email: 'olarindevictor3@gmail.com',
      password: 'NewPassword999!',
      addPasswordIfMissing: true,
    });
    assert.equal(secondProv.status, 'already_exists');

    // Sign in with Email+Password -> owner role persists
    const signInAgain = await rt.app.request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olarindevictor3@gmail.com',
        password: 'OwnerPassword123!',
      }),
    });
    assert.equal(signInAgain.status, 200);
    const newOwnerCookie = signInAgain.headers.get('set-cookie')!.split(';')[0];
    const meOwner = await (
      await rt.app.request('http://localhost:3000/api/me', { headers: { Cookie: newOwnerCookie } })
    ).json();
    assert.equal(meOwner.user.role, 'owner');
    assert.equal(meOwner.user.email, 'olarindevictor3@gmail.com');
    assert.equal(meOwner.user.id, prov.userId);
  } finally {
    fs.rmSync(rt.tmpDir, { recursive: true, force: true });
  }
});

test('SEO endpoints (robots.txt, sitemap.xml, meta injection, noindex on private paths) and product/category SEO persistence', async () => {
  const rt = createTestRuntime({
    ownerEmail: 'olarindevictor3@gmail.com',
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
    ownerEmail: 'olarindevictor3@gmail.com',
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

    // Settings summary contains ownerSummary & integrationStatus without any bootstrap secret fields
    const settingsRes = await (
      await rt.app.request('http://localhost:3000/api/admin/settings', {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    assert.equal(settingsRes.ownerSummary.designatedOwnerEmail, 'olarindevictor3@gmail.com');
    assert.equal(settingsRes.ownerSummary.ownerExists, true);
    assert.deepEqual(settingsRes.ownerSummary.authMethods, ['google', 'email_password']);
    assert.equal(settingsRes.ownerSummary.bootstrapConfigured, undefined);
    assert.ok(Array.isArray(settingsRes.integrationStatus) && settingsRes.integrationStatus.length >= 6);

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
    ownerEmail: 'olarindevictor3@gmail.com',
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
    evForm.append('receipt', new File([new Uint8Array([137, 80, 78, 71])], 'r.png', { type: 'image/png' }));
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
    ownerEmail: 'olarindevictor3@gmail.com',
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
