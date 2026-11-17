import {
  generateRecoveryCode,
  hashAdminSecurityPassword,
  randomHex,
  randomUuid,
  sha256Hex,
  verifyAdminSecurityPassword,
} from './crypto';
import type { SelloraDb } from './db';
import {
  dispatchSingleEmailEvent,
  getEffectiveEmailConfig,
  queueEmailEvent,
  renderSelloraEmailHtml,
  type EmailEnvConfig,
} from './email';
import { extractApproxLocation, parseDeviceSummary } from './login-monitor';
import {
  checkPersistentRateLimit,
  extractSessionTokenFromHeaders,
  getTrustedClientIp,
  recordSecurityEvent,
  writeAuditLog,
} from './security';
import { formatLagosDate, type AdminSecurityStatus } from '../shared/types';

export const ADMIN_DEVICE_COOKIE_NAME = 'sellora_admin_device';
export const ADMIN_APPROVAL_TTL_MS = 20 * 60_000; // 20 minutes
export const ADMIN_SEC_PASSWORD_SESSION_TTL_MS = 12 * 3_600_000; // 12 hours
export const ADMIN_SEC_PASSWORD_MAX_ATTEMPTS = 3;
export const ADMIN_SEC_PASSWORD_BASE_LOCK_MS = 5 * 60_000; // 5 minutes
export const ADMIN_SEC_PASSWORD_STEP_MS = 5 * 60_000; // +5 minutes per cycle
export const ADMIN_SEC_PASSWORD_MAX_LOCK_MS = 30 * 60_000; // 30 minutes max

type EnvLike = EmailEnvConfig & {
  runtime?: 'worker' | 'node';
  trustedProxy?: boolean;
  ownerEmail?: string;
};

export function extractAdminDeviceToken(headers: Headers): string | null {
  const raw = headers.get('cookie') || '';
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === ADMIN_DEVICE_COOKIE_NAME) {
      try {
        const val = decodeURIComponent(rest.join('=')).trim();
        if (/^[a-f0-9]{64}$/i.test(val)) return val.toLowerCase();
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function buildAdminDeviceCookieHeader(rawToken: string, isHttps: boolean): string {
  const base = `${ADMIN_DEVICE_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
  return isHttps ? `${base}; Secure` : base;
}

export function validateAdminSecurityPasswordStrength(raw: string): {
  ok: boolean;
  error?: string;
} {
  const pwd = (raw || '').normalize('NFKC');
  if (pwd.length < 8) {
    return { ok: false, error: 'Admin Security Password must be at least 8 characters.' };
  }
  if (pwd.length > 128) {
    return { ok: false, error: 'Admin Security Password must not exceed 128 characters.' };
  }
  if (/^\s+$/.test(pwd)) {
    return { ok: false, error: 'Admin Security Password cannot be only whitespace.' };
  }
  return { ok: true };
}

async function dispatchAdminApprovalAlertEmail(
  db: SelloraDb,
  env: EnvLike,
  params: {
    approvalId: string;
    userEmail: string;
    userName?: string | null;
    eventRef: string;
    triggerReason: 'unfamiliar_device' | 'unfamiliar_ip' | 'unfamiliar_device_and_ip';
    deviceSummary: string;
    ipAddress: string;
    approxLocation: string;
    requestedAtIso: string;
    expiresAtIso: string;
    approveToken: string;
    rejectToken: string;
  }
): Promise<{ approveUrl: string; rejectUrl: string }> {
  const cfg = await getEffectiveEmailConfig(db, env);
  const recipient = cfg.adminNotificationEmail || env.ownerEmail || params.userEmail;
  const approveUrl = `${cfg.resolvedAppUrl}/api/security/admin-approval?action=approve&token=${encodeURIComponent(params.approveToken)}`;
  const rejectUrl = `${cfg.resolvedAppUrl}/api/security/admin-approval?action=reject&token=${encodeURIComponent(params.rejectToken)}`;

  const reasonLabel =
    params.triggerReason === 'unfamiliar_device_and_ip'
      ? 'Unrecognized Device and Unrecognized IP Address'
      : params.triggerReason === 'unfamiliar_device'
        ? 'Unrecognized Browser / Device'
        : 'Unrecognized IP Address';

  try {
    const html = renderSelloraEmailHtml({
      title: 'Action Required: Admin Access Security Lock',
      greeting: `Hello ${params.userName || 'Store Administrator'},`,
      intro:
        'An administrative sign-in attempt triggered SELLORA\'s strict device and IP security policy. Dashboard access is currently LOCKED for that session until you review the details below and confirm or reject the request.',
      detailsRows: [
        { label: 'Alert Reference', value: params.eventRef },
        { label: 'Account', value: params.userEmail },
        { label: 'Trigger Reason', value: reasonLabel },
        { label: 'Request Time (WAT)', value: formatLagosDate(params.requestedAtIso) },
        { label: 'Request Time (UTC)', value: params.requestedAtIso },
        { label: 'Device / Client', value: params.deviceSummary },
        { label: 'IP Address', value: params.ipAddress },
        { label: 'Approx. Location', value: params.approxLocation },
        { label: 'Link Expires (UTC)', value: params.expiresAtIso },
      ],
      ctaLabel: 'YES — APPROVE ACCESS',
      ctaUrl: approveUrl,
      footerNote: `If you do NOT recognize this attempt, click NO — REJECT ACCESS to immediately block and terminate that session: ${rejectUrl} . Never forward this email; approval links are single-use and do not contain passwords.`,
    });

    const queued = await queueEmailEvent(db, {
      idempotencyKey: `adm_sec_lock:${params.approvalId}`,
      recipientEmail: recipient,
      recipientType: 'admin',
      notificationType: 'security_admin_approval_required',
      subject: `[SELLORA Security Lock] Admin Access Approval Required (${params.eventRef})`,
      htmlBody: html,
    });
    if (queued.queued && queued.eventId) {
      await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
    }
  } catch {
    // Lock state remains fail-closed even if outbound mail dispatch errors
  }

  return { approveUrl, rejectUrl };
}

async function createPendingApprovalForSession(
  db: SelloraDb,
  env: EnvLike,
  params: {
    headers: Headers;
    sessionId: string;
    userId: string;
    userEmail: string;
    userName?: string | null;
    loginId?: string | null;
    deviceTokenHash: string;
    ip: string;
  }
): Promise<{
  approvalId: string;
  eventRef: string;
  triggerReason: 'unfamiliar_device' | 'unfamiliar_ip' | 'unfamiliar_device_and_ip';
  expiresAt: string;
  approveUrl: string;
  rejectUrl: string;
}> {
  const ua = params.headers.get('user-agent') || '';
  const device = parseDeviceSummary(ua);
  const geo = extractApproxLocation(params.headers);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ADMIN_APPROVAL_TTL_MS).toISOString();

  const knownDevice = await db.get<{ id: string }>(
    `SELECT id FROM admin_trusted_devices WHERE user_id = ? AND device_token_hash = ? AND is_active = 1 LIMIT 1`,
    [params.userId, params.deviceTokenHash]
  );
  const knownIp = await db.get<{ id: string }>(
    `SELECT id FROM admin_trusted_devices WHERE user_id = ? AND trusted_ip = ? AND is_active = 1 LIMIT 1`,
    [params.userId, params.ip]
  );

  const triggerReason: 'unfamiliar_device' | 'unfamiliar_ip' | 'unfamiliar_device_and_ip' =
    knownDevice && !knownIp
      ? 'unfamiliar_ip'
      : !knownDevice && knownIp
        ? 'unfamiliar_device'
        : 'unfamiliar_device_and_ip';

  const eventRef = await recordSecurityEvent(db, {
    userId: params.userId,
    email: params.userEmail,
    eventCategory: 'admin_unfamiliar_access_locked',
    severity: 'high',
    riskLevel: 'high',
    status: 'recorded',
    ipAddress: params.ip,
    approxLocation: geo.label,
    deviceSummary: device.summary,
    userAgent: ua,
    metadata: {
      sessionId: params.sessionId,
      triggerReason,
      strictPolicy: true,
    },
  });

  const approvalId = `apv_${randomUuid()}`;
  const approveToken = randomHex(32);
  const rejectToken = randomHex(32);
  const [approveHash, rejectHash] = await Promise.all([
    sha256Hex(approveToken),
    sha256Hex(rejectToken),
  ]);

  await db.batch([
    {
      sql: `UPDATE admin_login_approvals
            SET status = 'expired'
            WHERE session_id = ? AND status = 'pending'`,
      params: [params.sessionId],
    },
    {
      sql: `INSERT INTO admin_login_approvals (
              id, session_id, user_id, login_id, event_ref, trigger_reason,
              device_token_hash, device_summary, ip_address, approx_location,
              approve_token_hash, reject_token_hash, status, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      params: [
        approvalId,
        params.sessionId,
        params.userId,
        params.loginId ?? null,
        eventRef,
        triggerReason,
        params.deviceTokenHash,
        device.summary,
        params.ip,
        geo.label,
        approveHash,
        rejectHash,
        expiresAt,
        now,
      ],
    },
    {
      sql: `INSERT INTO admin_session_verifications (
              session_id, user_id, device_approval_status, approval_id,
              sec_password_verified_at, sec_password_expires_at,
              bound_device_token_hash, bound_ip, created_at, updated_at
            ) VALUES (?, ?, 'pending', ?, NULL, NULL, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              device_approval_status = 'pending',
              approval_id = excluded.approval_id,
              sec_password_verified_at = NULL,
              sec_password_expires_at = NULL,
              bound_device_token_hash = excluded.bound_device_token_hash,
              bound_ip = excluded.bound_ip,
              updated_at = excluded.updated_at`,
      params: [
        params.sessionId,
        params.userId,
        approvalId,
        params.deviceTokenHash,
        params.ip,
        now,
        now,
      ],
    },
  ]);

  await writeAuditLog(db, {
    actorId: params.userId,
    actorEmail: params.userEmail,
    action: 'ADMIN_SESSION_LOCKED_STRICT_POLICY',
    targetType: 'session',
    targetId: params.sessionId,
    details: { approvalId, triggerReason, eventRef },
    ipAddress: params.ip,
  });

  const urls = await dispatchAdminApprovalAlertEmail(db, env, {
    approvalId,
    userEmail: params.userEmail,
    userName: params.userName,
    eventRef,
    triggerReason,
    deviceSummary: device.summary,
    ipAddress: params.ip,
    approxLocation: geo.label,
    requestedAtIso: now,
    expiresAtIso: expiresAt,
    approveToken,
    rejectToken,
  });

  return {
    approvalId,
    eventRef,
    triggerReason,
    expiresAt,
    approveUrl: urls.approveUrl,
    rejectUrl: urls.rejectUrl,
  };
}

/**
 * Evaluates strict device + IP policy immediately upon admin login session issuance.
 */
export async function evaluateAdminLoginGate(
  db: SelloraDb,
  env: EnvLike,
  params: {
    headers: Headers;
    sessionId: string;
    userId: string;
    userEmail: string;
    userName?: string | null;
    loginId?: string | null;
  }
): Promise<{
  deviceApprovalStatus: 'trusted' | 'pending';
  newDeviceCookieValue: string | null;
  approvalId?: string;
  approveUrl?: string;
  rejectUrl?: string;
}> {
  const existingCookieToken = extractAdminDeviceToken(params.headers);
  const rawDeviceToken = existingCookieToken || randomHex(32);
  const newDeviceCookieValue = existingCookieToken ? null : rawDeviceToken;
  const deviceTokenHash = await sha256Hex(rawDeviceToken);
  const ip = getTrustedClientIp(params.headers, env);
  const now = new Date().toISOString();

  const trusted = await db.get<{ id: string }>(
    `SELECT id FROM admin_trusted_devices
     WHERE user_id = ? AND device_token_hash = ? AND trusted_ip = ? AND is_active = 1
     LIMIT 1`,
    [params.userId, deviceTokenHash, ip]
  );

  if (trusted) {
    await db.batch([
      {
        sql: `UPDATE admin_trusted_devices SET last_seen_at = ? WHERE id = ?`,
        params: [now, trusted.id],
      },
      {
        sql: `INSERT INTO admin_session_verifications (
                session_id, user_id, device_approval_status, approval_id,
                sec_password_verified_at, sec_password_expires_at,
                bound_device_token_hash, bound_ip, created_at, updated_at
              ) VALUES (?, ?, 'trusted', NULL, NULL, NULL, ?, ?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                device_approval_status = 'trusted',
                approval_id = NULL,
                sec_password_verified_at = NULL,
                sec_password_expires_at = NULL,
                bound_device_token_hash = excluded.bound_device_token_hash,
                bound_ip = excluded.bound_ip,
                updated_at = excluded.updated_at`,
        params: [params.sessionId, params.userId, deviceTokenHash, ip, now, now],
      },
    ]);
    return { deviceApprovalStatus: 'trusted', newDeviceCookieValue };
  }

  const pending = await createPendingApprovalForSession(db, env, {
    headers: params.headers,
    sessionId: params.sessionId,
    userId: params.userId,
    userEmail: params.userEmail,
    userName: params.userName,
    loginId: params.loginId,
    deviceTokenHash,
    ip,
  });

  return {
    deviceApprovalStatus: 'pending',
    newDeviceCookieValue,
    approvalId: pending.approvalId,
    approveUrl: pending.approveUrl,
    rejectUrl: pending.rejectUrl,
  };
}

/**
 * Resolves live strict security state for an authenticated privileged session.
 * Fail-closed: expires only timed-out pending sessions cleanly without locking out future logins.
 */
export async function getAdminSessionSecurityState(
  db: SelloraDb,
  env: EnvLike,
  headers: Headers,
  user: { id: string; email: string; name?: string | null; role: string }
): Promise<AdminSecurityStatus & { sessionId: string | null }> {
  if (user.role === 'customer') {
    return {
      required: false,
      unlocked: true,
      lockCode: null,
      deviceApprovalStatus: 'trusted',
      secondaryPasswordConfigured: false,
      secondaryPasswordVerified: true,
      sessionId: null,
    };
  }

  const sessionToken = extractSessionTokenFromHeaders(headers);
  const currentIp = getTrustedClientIp(headers, env);
  const currentDeviceSummary = parseDeviceSummary(headers.get('user-agent')).summary;
  const rawDevice = extractAdminDeviceToken(headers);
  const currentDeviceHash = rawDevice ? await sha256Hex(rawDevice) : '';
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  if (!sessionToken) {
    return {
      required: true,
      unlocked: false,
      lockCode: 'ADMIN_SECURITY_LOCKED',
      deviceApprovalStatus: 'pending',
      secondaryPasswordConfigured: false,
      secondaryPasswordVerified: false,
      currentIp,
      currentDeviceSummary,
      sessionId: null,
    };
  }

  const sessionRow = await db.get<{ id: string; expiresAt: string }>(
    `SELECT id, expiresAt FROM session WHERE token = ? AND userId = ? AND expiresAt > ?`,
    [sessionToken, user.id, nowIso]
  );

  if (!sessionRow) {
    return {
      required: true,
      unlocked: false,
      lockCode: 'ADMIN_SECURITY_LOCKED',
      deviceApprovalStatus: 'expired',
      secondaryPasswordConfigured: false,
      secondaryPasswordVerified: false,
      currentIp,
      currentDeviceSummary,
      sessionId: null,
    };
  }

  let verif = await db.get<{
    session_id: string;
    device_approval_status: 'trusted' | 'pending' | 'approved' | 'rejected' | 'expired';
    approval_id: string | null;
    sec_password_verified_at: string | null;
    sec_password_expires_at: string | null;
    bound_device_token_hash: string;
    bound_ip: string;
  }>(`SELECT * FROM admin_session_verifications WHERE session_id = ?`, [sessionRow.id]);

  // Lazily expire a timed-out pending approval ONLY for this specific session
  if (verif?.device_approval_status === 'pending' && verif.approval_id) {
    const apv = await db.get<{
      id: string;
      status: string;
      expires_at: string;
      trigger_reason: string;
    }>(`SELECT id, status, expires_at, trigger_reason FROM admin_login_approvals WHERE id = ?`, [
      verif.approval_id,
    ]);
    if (apv && apv.status === 'pending' && apv.expires_at <= nowIso) {
      await db.batch([
        {
          sql: `UPDATE admin_login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'`,
          params: [apv.id],
        },
        {
          sql: `UPDATE admin_session_verifications
                SET device_approval_status = 'expired',
                    sec_password_verified_at = NULL,
                    sec_password_expires_at = NULL,
                    updated_at = ?
                WHERE session_id = ?`,
          params: [nowIso, sessionRow.id],
        },
      ]);
      verif = { ...verif, device_approval_status: 'expired', sec_password_verified_at: null, sec_password_expires_at: null };
    }
  }

  // If session verification is missing OR caller switched device cookie / IP mid-session -> re-check strictly
  const ipOrDeviceMismatch =
    !verif ||
    ((verif.device_approval_status === 'trusted' || verif.device_approval_status === 'approved') &&
      (!currentDeviceHash ||
        verif.bound_device_token_hash !== currentDeviceHash ||
        verif.bound_ip !== currentIp));

  if (ipOrDeviceMismatch) {
    const matchedTrusted = currentDeviceHash
      ? await db.get<{ id: string }>(
          `SELECT id FROM admin_trusted_devices
           WHERE user_id = ? AND device_token_hash = ? AND trusted_ip = ? AND is_active = 1
           LIMIT 1`,
          [user.id, currentDeviceHash, currentIp]
        )
      : null;

    if (matchedTrusted) {
      await db.batch([
        {
          sql: `UPDATE admin_trusted_devices SET last_seen_at = ? WHERE id = ?`,
          params: [nowIso, matchedTrusted.id],
        },
        {
          sql: `INSERT INTO admin_session_verifications (
                  session_id, user_id, device_approval_status, approval_id,
                  sec_password_verified_at, sec_password_expires_at,
                  bound_device_token_hash, bound_ip, created_at, updated_at
                ) VALUES (?, ?, 'trusted', NULL, NULL, NULL, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                  device_approval_status = 'trusted',
                  sec_password_verified_at = NULL,
                  sec_password_expires_at = NULL,
                  bound_device_token_hash = excluded.bound_device_token_hash,
                  bound_ip = excluded.bound_ip,
                  updated_at = excluded.updated_at`,
          params: [sessionRow.id, user.id, currentDeviceHash, currentIp, nowIso, nowIso],
        },
      ]);
      verif = {
        session_id: sessionRow.id,
        device_approval_status: 'trusted',
        approval_id: null,
        sec_password_verified_at: null,
        sec_password_expires_at: null,
        bound_device_token_hash: currentDeviceHash,
        bound_ip: currentIp,
      };
    } else {
      const effectiveHash = currentDeviceHash || (await sha256Hex(`missing:${sessionRow.id}:${currentIp}`));
      const pending = await createPendingApprovalForSession(db, env, {
        headers,
        sessionId: sessionRow.id,
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        deviceTokenHash: effectiveHash,
        ip: currentIp,
      });
      verif = {
        session_id: sessionRow.id,
        device_approval_status: 'pending',
        approval_id: pending.approvalId,
        sec_password_verified_at: null,
        sec_password_expires_at: null,
        bound_device_token_hash: effectiveHash,
        bound_ip: currentIp,
      };
    }
  }

  let approvalMeta: { id: string; trigger_reason: string; expires_at: string; status: string } | null = null;
  if (verif?.approval_id) {
    approvalMeta = await db.get<{ id: string; trigger_reason: string; expires_at: string; status: string }>(
      `SELECT id, trigger_reason, expires_at, status FROM admin_login_approvals WHERE id = ?`,
      [verif.approval_id]
    );
  }

  const cred = await db.get<{
    user_id: string;
    failed_attempts: number;
    lockout_cycles: number;
    locked_until_ms: number;
  }>(`SELECT user_id, failed_attempts, lockout_cycles, locked_until_ms FROM admin_security_credentials WHERE user_id = ?`, [
    user.id,
  ]);

  const secondaryPasswordConfigured = Boolean(cred);
  const deviceReady =
    verif?.device_approval_status === 'trusted' || verif?.device_approval_status === 'approved';
  const secondaryPasswordVerified = Boolean(
    deviceReady &&
      secondaryPasswordConfigured &&
      verif?.sec_password_verified_at &&
      verif?.sec_password_expires_at &&
      verif.sec_password_expires_at > nowIso
  );

  const lockCode = !deviceReady
    ? 'ADMIN_SECURITY_LOCKED'
    : !secondaryPasswordConfigured
      ? 'ADMIN_SEC_PASSWORD_SETUP_REQUIRED'
      : !secondaryPasswordVerified
        ? 'ADMIN_SEC_PASSWORD_REQUIRED'
        : null;

  const lockedUntilMs = Number(cred?.locked_until_ms || 0);
  const retryAfterSec = lockedUntilMs > nowMs ? Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 1000)) : 0;

  return {
    required: true,
    unlocked: lockCode === null,
    lockCode,
    deviceApprovalStatus: verif!.device_approval_status,
    triggerReason: approvalMeta?.trigger_reason ?? null,
    pendingApprovalId: approvalMeta?.id ?? null,
    approvalExpiresAt: approvalMeta?.expires_at ?? null,
    secondaryPasswordConfigured,
    secondaryPasswordVerified,
    secondaryPasswordExpiresAt: verif?.sec_password_expires_at ?? null,
    secondaryPasswordLockedUntilMs: lockedUntilMs > nowMs ? lockedUntilMs : 0,
    secondaryPasswordRetryAfterSec: retryAfterSec,
    currentIp,
    currentDeviceSummary,
    sessionId: sessionRow.id,
  };
}

export async function setupAdminSecurityPassword(
  db: SelloraDb,
  env: EnvLike,
  params: {
    userId: string;
    userEmail: string;
    userRole: string;
    sessionId: string;
    newPassword: string;
    ip: string;
  }
): Promise<{ ok: boolean; status: number; recoveryCode?: string; error?: string }> {
  const existing = await db.get<{ user_id: string }>(
    `SELECT user_id FROM admin_security_credentials WHERE user_id = ?`,
    [params.userId]
  );
  if (existing) {
    return { ok: false, status: 409, error: 'Admin Security Password is already configured.' };
  }

  const strength = validateAdminSecurityPasswordStrength(params.newPassword);
  if (!strength.ok) {
    return { ok: false, status: 400, error: strength.error };
  }

  const { encodedHash, algorithmId } = await hashAdminSecurityPassword(params.newPassword);
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = await sha256Hex(recoveryCode);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const secExpiresAt = new Date(nowMs + ADMIN_SEC_PASSWORD_SESSION_TTL_MS).toISOString();

  await db.batch([
    {
      sql: `INSERT INTO admin_security_credentials (
              user_id, password_hash, hash_algorithm, failed_attempts, lockout_cycles,
              locked_until_ms, recovery_code_hash, password_updated_at, created_at
            ) VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)`,
      params: [params.userId, encodedHash, algorithmId, recoveryCodeHash, now, now],
    },
    {
      sql: `UPDATE admin_session_verifications
            SET sec_password_verified_at = ?, sec_password_expires_at = ?, updated_at = ?
            WHERE session_id = ? AND user_id = ?`,
      params: [now, secExpiresAt, now, params.sessionId, params.userId],
    },
  ]);

  await writeAuditLog(db, {
    actorId: params.userId,
    actorEmail: params.userEmail,
    actorRole: params.userRole,
    action: 'ADMIN_SEC_PASSWORD_CONFIGURED',
    targetType: 'user',
    targetId: params.userId,
    ipAddress: params.ip,
  });

  await recordSecurityEvent(db, {
    userId: params.userId,
    email: params.userEmail,
    eventCategory: 'admin_security_password_configured',
    severity: 'medium',
    riskLevel: 'low',
    status: 'resolved',
    ipAddress: params.ip,
  });

  const cfg = await getEffectiveEmailConfig(db, env);
  if (cfg.adminNotificationEmail) {
    const html = renderSelloraEmailHtml({
      title: 'Admin Security Password Configured',
      greeting: 'Store Administration Notice,',
      intro: 'A separate Admin Security Password was configured for your administrative account.',
      detailsRows: [
        { label: 'Account', value: params.userEmail },
        { label: 'Client IP', value: params.ip },
        { label: 'Time (WAT)', value: formatLagosDate(now) },
      ],
    });
    const queued = await queueEmailEvent(db, {
      idempotencyKey: `sec_pwd_setup:${params.userId}:${nowMs}`,
      recipientEmail: cfg.adminNotificationEmail,
      recipientType: 'admin',
      notificationType: 'security_admin_password_changed',
      subject: '[SELLORA Security] Admin Security Password Configured',
      htmlBody: html,
    });
    if (queued.queued && queued.eventId) {
      await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
    }
  }

  return { ok: true, status: 201, recoveryCode };
}

export async function verifyAdminSecurityPasswordForSession(
  db: SelloraDb,
  env: EnvLike,
  params: {
    userId: string;
    userEmail: string;
    userRole: string;
    sessionId: string;
    password: string;
    ip: string;
  }
): Promise<{ ok: boolean; status: number; retryAfterSec?: number; expiresAt?: string; error?: string }> {
  const rl = await checkPersistentRateLimit(db, `admin_sec_pwd:${params.userId}:${params.ip}`, 12, 60_000);
  if (!rl.allowed) {
    return {
      ok: false,
      status: 429,
      retryAfterSec: rl.retryAfterSec,
      error: 'Too many security password attempts. Please wait a moment.',
    };
  }

  const cred = await db.get<{
    password_hash: string;
    failed_attempts: number;
    lockout_cycles: number;
    locked_until_ms: number;
  }>(`SELECT * FROM admin_security_credentials WHERE user_id = ?`, [params.userId]);

  if (!cred) {
    return { ok: false, status: 400, error: 'Admin Security Password is not configured yet.' };
  }

  const nowMs = Date.now();
  if (cred.locked_until_ms > nowMs) {
    const retryAfterSec = Math.max(1, Math.ceil((cred.locked_until_ms - nowMs) / 1000));
    return {
      ok: false,
      status: 429,
      retryAfterSec,
      error: 'Security password verification is temporarily paused due to repeated incorrect attempts.',
    };
  }

  const valid = await verifyAdminSecurityPassword(params.password || '', cred.password_hash);
  const now = new Date(nowMs).toISOString();

  if (!valid) {
    const nextAttempts = Number(cred.failed_attempts || 0) + 1;
    let nextCycles = Number(cred.lockout_cycles || 0);
    let nextLockedUntil = 0;
    let retryAfterSec = 0;

    if (nextAttempts >= ADMIN_SEC_PASSWORD_MAX_ATTEMPTS) {
      nextCycles += 1;
      const lockDurationMs = Math.min(
        ADMIN_SEC_PASSWORD_MAX_LOCK_MS,
        ADMIN_SEC_PASSWORD_BASE_LOCK_MS + (nextCycles - 1) * ADMIN_SEC_PASSWORD_STEP_MS
      );
      nextLockedUntil = nowMs + lockDurationMs;
      retryAfterSec = Math.ceil(lockDurationMs / 1000);
    }

    await db.run(
      `UPDATE admin_security_credentials
       SET failed_attempts = ?, lockout_cycles = ?, locked_until_ms = ?
       WHERE user_id = ?`,
      [nextAttempts >= ADMIN_SEC_PASSWORD_MAX_ATTEMPTS ? 0 : nextAttempts, nextCycles, nextLockedUntil, params.userId]
    );

    await recordSecurityEvent(db, {
      userId: params.userId,
      email: params.userEmail,
      eventCategory: nextLockedUntil > 0 ? 'admin_sec_password_lockout' : 'admin_sec_password_failed',
      severity: nextLockedUntil > 0 ? 'high' : 'medium',
      riskLevel: nextLockedUntil > 0 ? 'high' : 'medium',
      ipAddress: params.ip,
      metadata: { nextAttempts, nextCycles, locked: nextLockedUntil > 0 },
    });

    if (nextLockedUntil > 0) {
      try {
        const cfg = await getEffectiveEmailConfig(db, env);
        if (cfg.adminNotificationEmail) {
          const html = renderSelloraEmailHtml({
            title: 'Security Notice: Admin Security Password Temporarily Paused',
            greeting: 'Store Administration Notice,',
            intro:
              'Repeated incorrect Admin Security Password attempts were detected on your account. Secondary verification has been temporarily paused.',
            detailsRows: [
              { label: 'Account', value: params.userEmail },
              { label: 'Cooldown', value: `${Math.ceil(retryAfterSec / 60)} minutes` },
              { label: 'Client IP', value: params.ip },
            ],
          });
          const queued = await queueEmailEvent(db, {
            idempotencyKey: `sec_pwd_lockout:${params.userId}:${nextCycles}`,
            recipientEmail: cfg.adminNotificationEmail,
            recipientType: 'admin',
            notificationType: 'security_admin_password_lockout',
            subject: '[SELLORA Security] Admin Security Password Temporarily Paused',
            htmlBody: html,
          });
          if (queued.queued && queued.eventId) {
            await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
          }
        }
      } catch {
        // non-fatal
      }

      return {
        ok: false,
        status: 429,
        retryAfterSec,
        error: 'Security password verification is temporarily paused due to repeated incorrect attempts.',
      };
    }

    return { ok: false, status: 401, error: 'Incorrect Admin Security Password.' };
  }

  const sessRow = await db.get<{ expiresAt: string }>(
    `SELECT expiresAt FROM session WHERE id = ? AND userId = ?`,
    [params.sessionId, params.userId]
  );
  const policyExpMs = nowMs + ADMIN_SEC_PASSWORD_SESSION_TTL_MS;
  const sessExpMs = sessRow?.expiresAt ? Date.parse(sessRow.expiresAt) : policyExpMs;
  const finalExpIso = new Date(Math.min(policyExpMs, Number.isFinite(sessExpMs) ? sessExpMs : policyExpMs)).toISOString();

  await db.batch([
    {
      sql: `UPDATE admin_security_credentials
            SET failed_attempts = 0, lockout_cycles = 0, locked_until_ms = 0
            WHERE user_id = ?`,
      params: [params.userId],
    },
    {
      sql: `UPDATE admin_session_verifications
            SET sec_password_verified_at = ?, sec_password_expires_at = ?, updated_at = ?
            WHERE session_id = ? AND user_id = ?`,
      params: [now, finalExpIso, now, params.sessionId, params.userId],
    },
  ]);

  await writeAuditLog(db, {
    actorId: params.userId,
    actorEmail: params.userEmail,
    actorRole: params.userRole,
    action: 'ADMIN_SEC_PASSWORD_VERIFIED',
    targetType: 'session',
    targetId: params.sessionId,
    ipAddress: params.ip,
  });

  return { ok: true, status: 200, expiresAt: finalExpIso };
}

export async function changeAdminSecurityPassword(
  db: SelloraDb,
  env: EnvLike,
  params: {
    userId: string;
    userEmail: string;
    userRole: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
    ip: string;
  }
): Promise<{ ok: boolean; status: number; recoveryCode?: string; error?: string }> {
  const cred = await db.get<{ password_hash: string }>(
    `SELECT password_hash FROM admin_security_credentials WHERE user_id = ?`,
    [params.userId]
  );
  if (!cred) {
    return { ok: false, status: 400, error: 'Admin Security Password is not configured yet.' };
  }

  const matchesCurrent = await verifyAdminSecurityPassword(params.currentPassword || '', cred.password_hash);
  if (!matchesCurrent) {
    return { ok: false, status: 401, error: 'Current Admin Security Password is incorrect.' };
  }

  const strength = validateAdminSecurityPasswordStrength(params.newPassword);
  if (!strength.ok) {
    return { ok: false, status: 400, error: strength.error };
  }

  const { encodedHash, algorithmId } = await hashAdminSecurityPassword(params.newPassword);
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = await sha256Hex(recoveryCode);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const secExpiresAt = new Date(nowMs + ADMIN_SEC_PASSWORD_SESSION_TTL_MS).toISOString();

  await db.batch([
    {
      sql: `UPDATE admin_security_credentials
            SET password_hash = ?, hash_algorithm = ?, failed_attempts = 0, lockout_cycles = 0,
                locked_until_ms = 0, recovery_code_hash = ?, password_updated_at = ?
            WHERE user_id = ?`,
      params: [encodedHash, algorithmId, recoveryCodeHash, now, params.userId],
    },
    {
      // Require re-verification on all OTHER active admin sessions
      sql: `UPDATE admin_session_verifications
            SET sec_password_verified_at = NULL, sec_password_expires_at = NULL, updated_at = ?
            WHERE user_id = ? AND session_id != ?`,
      params: [now, params.userId, params.sessionId],
    },
    {
      sql: `UPDATE admin_session_verifications
            SET sec_password_verified_at = ?, sec_password_expires_at = ?, updated_at = ?
            WHERE session_id = ? AND user_id = ?`,
      params: [now, secExpiresAt, now, params.sessionId, params.userId],
    },
  ]);

  await writeAuditLog(db, {
    actorId: params.userId,
    actorEmail: params.userEmail,
    actorRole: params.userRole,
    action: 'ADMIN_SEC_PASSWORD_CHANGED',
    targetType: 'user',
    targetId: params.userId,
    ipAddress: params.ip,
  });

  await recordSecurityEvent(db, {
    userId: params.userId,
    email: params.userEmail,
    eventCategory: 'admin_security_password_changed',
    severity: 'high',
    riskLevel: 'low',
    status: 'resolved',
    ipAddress: params.ip,
  });

  const cfg = await getEffectiveEmailConfig(db, env);
  if (cfg.adminNotificationEmail) {
    const html = renderSelloraEmailHtml({
      title: 'Admin Security Password Updated',
      greeting: 'Store Administration Notice,',
      intro:
        'Your Admin Security Password was changed. All other active administrative sessions will be required to re-verify.',
      detailsRows: [
        { label: 'Account', value: params.userEmail },
        { label: 'Client IP', value: params.ip },
        { label: 'Time (WAT)', value: formatLagosDate(now) },
      ],
    });
    const queued = await queueEmailEvent(db, {
      idempotencyKey: `sec_pwd_chg:${params.userId}:${nowMs}`,
      recipientEmail: cfg.adminNotificationEmail,
      recipientType: 'admin',
      notificationType: 'security_admin_password_changed',
      subject: '[SELLORA Security] Admin Security Password Changed',
      htmlBody: html,
    });
    if (queued.queued && queued.eventId) {
      await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
    }
  }

  return { ok: true, status: 200, recoveryCode };
}

export async function requestAdminSecurityPasswordRecovery(
  db: SelloraDb,
  env: EnvLike,
  params: { userId: string; userEmail: string; userName?: string | null; ip: string }
): Promise<{ ok: boolean; status: number; message: string }> {
  const cred = await db.get<{ user_id: string }>(
    `SELECT user_id FROM admin_security_credentials WHERE user_id = ?`,
    [params.userId]
  );
  if (!cred) {
    return { ok: false, status: 400, message: 'Admin Security Password is not configured yet.' };
  }

  const rawToken = randomHex(32);
  const tokenHash = await sha256Hex(rawToken);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + 15 * 60_000).toISOString();

  await db.run(
    `UPDATE admin_security_credentials
     SET email_recovery_token_hash = ?, email_recovery_expires_at = ?
     WHERE user_id = ?`,
    [tokenHash, expiresAt, params.userId]
  );

  const cfg = await getEffectiveEmailConfig(db, env);
  const recipient = cfg.adminNotificationEmail || params.userEmail;
  const html = renderSelloraEmailHtml({
    title: 'Admin Security Password Recovery Request',
    greeting: `Hello ${params.userName || 'Store Administrator'},`,
    intro:
      'Use the one-time recovery token below on the Admin Security Password verification screen to set a new Admin Security Password. This token expires in 15 minutes.',
    detailsRows: [
      { label: 'Account', value: params.userEmail },
      { label: 'One-Time Recovery Token', value: rawToken },
      { label: 'Requested From IP', value: params.ip },
      { label: 'Expires (UTC)', value: expiresAt },
    ],
    footerNote:
      'If you did not initiate this recovery request, review active sessions and recognized devices immediately.',
  });
  const queued = await queueEmailEvent(db, {
    idempotencyKey: `sec_pwd_rec:${params.userId}:${nowMs}`,
    recipientEmail: recipient,
    recipientType: 'admin',
    notificationType: 'security_admin_password_recovery',
    subject: '[SELLORA Security] Admin Security Password Recovery Token',
    htmlBody: html,
  });
  if (queued.queued && queued.eventId) {
    await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
  }

  await recordSecurityEvent(db, {
    userId: params.userId,
    email: params.userEmail,
    eventCategory: 'admin_security_password_recovery_requested',
    severity: 'high',
    riskLevel: 'medium',
    ipAddress: params.ip,
    metadata: { timestamp: now },
  });

  return {
    ok: true,
    status: 200,
    message: 'A single-use recovery token has been queued to the registered administrator inbox.',
  };
}

export async function confirmAdminSecurityPasswordRecovery(
  db: SelloraDb,
  env: EnvLike,
  params: {
    userId: string;
    userEmail: string;
    userRole: string;
    sessionId: string;
    recoveryTokenOrCode: string;
    newPassword: string;
    ip: string;
  }
): Promise<{ ok: boolean; status: number; recoveryCode?: string; error?: string }> {
  const cred = await db.get<{
    recovery_code_hash: string | null;
    email_recovery_token_hash: string | null;
    email_recovery_expires_at: string | null;
  }>(
    `SELECT recovery_code_hash, email_recovery_token_hash, email_recovery_expires_at
     FROM admin_security_credentials WHERE user_id = ?`,
    [params.userId]
  );
  if (!cred) {
    return { ok: false, status: 400, error: 'Admin Security Password is not configured yet.' };
  }

  const strength = validateAdminSecurityPasswordStrength(params.newPassword);
  if (!strength.ok) {
    return { ok: false, status: 400, error: strength.error };
  }

  const supplied = (params.recoveryTokenOrCode || '').trim();
  if (!supplied) {
    return { ok: false, status: 400, error: 'Recovery token or backup recovery code is required.' };
  }
  const suppliedHash = await sha256Hex(supplied);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  const matchesBackupCode = Boolean(cred.recovery_code_hash && cred.recovery_code_hash === suppliedHash);
  const matchesEmailToken = Boolean(
    cred.email_recovery_token_hash &&
      cred.email_recovery_token_hash === suppliedHash &&
      cred.email_recovery_expires_at &&
      cred.email_recovery_expires_at > now
  );

  if (!matchesBackupCode && !matchesEmailToken) {
    return { ok: false, status: 400, error: 'Invalid or expired recovery token/code.' };
  }

  const { encodedHash, algorithmId } = await hashAdminSecurityPassword(params.newPassword);
  const nextRecoveryCode = generateRecoveryCode();
  const nextRecoveryCodeHash = await sha256Hex(nextRecoveryCode);
  const secExpiresAt = new Date(nowMs + ADMIN_SEC_PASSWORD_SESSION_TTL_MS).toISOString();

  await db.batch([
    {
      sql: `UPDATE admin_security_credentials
            SET password_hash = ?, hash_algorithm = ?, failed_attempts = 0, lockout_cycles = 0,
                locked_until_ms = 0, recovery_code_hash = ?, email_recovery_token_hash = NULL,
                email_recovery_expires_at = NULL, password_updated_at = ?
            WHERE user_id = ?`,
      params: [encodedHash, algorithmId, nextRecoveryCodeHash, now, params.userId],
    },
    {
      sql: `UPDATE admin_session_verifications
            SET sec_password_verified_at = NULL, sec_password_expires_at = NULL, updated_at = ?
            WHERE user_id = ? AND session_id != ?`,
      params: [now, params.userId, params.sessionId],
    },
    {
      sql: `UPDATE admin_session_verifications
            SET sec_password_verified_at = ?, sec_password_expires_at = ?, updated_at = ?
            WHERE session_id = ? AND user_id = ?`,
      params: [now, secExpiresAt, now, params.sessionId, params.userId],
    },
  ]);

  await writeAuditLog(db, {
    actorId: params.userId,
    actorEmail: params.userEmail,
    actorRole: params.userRole,
    action: 'ADMIN_SEC_PASSWORD_RECOVERED',
    targetType: 'user',
    targetId: params.userId,
    details: { method: matchesBackupCode ? 'backup_code' : 'email_token' },
    ipAddress: params.ip,
  });

  await recordSecurityEvent(db, {
    userId: params.userId,
    email: params.userEmail,
    eventCategory: 'admin_security_password_recovered',
    severity: 'high',
    riskLevel: 'medium',
    status: 'resolved',
    ipAddress: params.ip,
  });

  const cfg = await getEffectiveEmailConfig(db, env);
  if (cfg.adminNotificationEmail) {
    const html = renderSelloraEmailHtml({
      title: 'Admin Security Password Reset Completed',
      greeting: 'Store Administration Notice,',
      intro: 'Your Admin Security Password was reset via recovery verification.',
      detailsRows: [
        { label: 'Account', value: params.userEmail },
        { label: 'Client IP', value: params.ip },
        { label: 'Time (WAT)', value: formatLagosDate(now) },
      ],
    });
    const queued = await queueEmailEvent(db, {
      idempotencyKey: `sec_pwd_rec_done:${params.userId}:${nowMs}`,
      recipientEmail: cfg.adminNotificationEmail,
      recipientType: 'admin',
      notificationType: 'security_admin_password_changed',
      subject: '[SELLORA Security] Admin Security Password Reset Completed',
      htmlBody: html,
    });
    if (queued.queued && queued.eventId) {
      await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
    }
  }

  return { ok: true, status: 200, recoveryCode: nextRecoveryCode };
}

export async function inspectAdminApprovalTokenReadOnly(
  db: SelloraDb,
  rawToken: string,
  expectedAction?: 'approve' | 'reject'
): Promise<{
  valid: boolean;
  actionType?: 'approve' | 'reject';
  approval?: {
    id: string;
    sessionId: string;
    userEmail: string;
    triggerReason: string;
    deviceSummary: string;
    ipAddress: string;
    approxLocation: string;
    createdAt: string;
    expiresAt: string;
    status: string;
  };
  error?: string;
}> {
  const token = (rawToken || '').trim();
  if (token.length < 32) {
    return { valid: false, error: 'Security approval token is invalid.' };
  }
  const tokenHash = await sha256Hex(token);

  const row = await db.get<{
    id: string;
    session_id: string;
    user_id: string;
    trigger_reason: string;
    device_summary: string;
    ip_address: string;
    approx_location: string | null;
    approve_token_hash: string;
    reject_token_hash: string;
    status: string;
    expires_at: string;
    created_at: string;
    user_email: string;
  }>(
    `SELECT a.*, u.email as user_email
     FROM admin_login_approvals a
     JOIN user u ON u.id = a.user_id
     WHERE a.approve_token_hash = ? OR a.reject_token_hash = ?`,
    [tokenHash, tokenHash]
  );

  if (!row) {
    return { valid: false, error: 'This security approval request was not found.' };
  }

  const tokenAction: 'approve' | 'reject' =
    row.approve_token_hash === tokenHash ? 'approve' : 'reject';

  if (expectedAction && expectedAction !== tokenAction) {
    return { valid: false, error: 'Action does not match the provided security token.' };
  }

  const now = new Date().toISOString();
  const baseApproval = {
    id: row.id,
    sessionId: row.session_id,
    userEmail: row.user_email,
    triggerReason: row.trigger_reason,
    deviceSummary: row.device_summary,
    ipAddress: row.ip_address,
    approxLocation: row.approx_location || 'Approximate location unavailable',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  };

  if (row.status !== 'pending') {
    return {
      valid: false,
      actionType: tokenAction,
      approval: baseApproval,
      error: `This access request has already been marked as ${row.status}.`,
    };
  }

  if (row.expires_at <= now) {
    return {
      valid: false,
      actionType: tokenAction,
      approval: { ...baseApproval, status: 'expired' },
      error:
        'This security approval link has expired and its login session can no longer be unlocked. Sign in again to generate a new approval request.',
    };
  }

  const sess = await db.get<{ id: string }>(
    `SELECT id FROM session WHERE id = ? AND expiresAt > ?`,
    [row.session_id, now]
  );
  if (!sess) {
    return {
      valid: false,
      actionType: tokenAction,
      approval: { ...baseApproval, status: 'expired' },
      error: 'The associated login session has already ended. Please sign in again.',
    };
  }

  return { valid: true, actionType: tokenAction, approval: baseApproval };
}

/**
 * Executes explicit POST approval or rejection of a pending admin login request.
 * Unlocks ONLY that exact session_id on approve, or revokes ONLY that session on reject.
 */
export async function executeAdminApprovalDecision(
  db: SelloraDb,
  env: EnvLike,
  params: {
    rawToken: string;
    action: 'approve' | 'reject';
    actorLabel?: string;
  }
): Promise<{
  ok: boolean;
  status: number;
  decision?: 'approved' | 'rejected';
  approvalId?: string;
  sessionId?: string;
  eventRef?: string | null;
  error?: string;
}> {
  const token = (params.rawToken || '').trim();
  if (token.length < 32) {
    return { ok: false, status: 400, error: 'Invalid security approval token.' };
  }
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();

  const row = await db.get<{
    id: string;
    session_id: string;
    user_id: string;
    event_ref: string | null;
    trigger_reason: string;
    device_token_hash: string;
    device_summary: string;
    ip_address: string;
    approx_location: string | null;
    approve_token_hash: string;
    reject_token_hash: string;
    status: string;
    expires_at: string;
  }>(
    `SELECT * FROM admin_login_approvals
     WHERE approve_token_hash = ? OR reject_token_hash = ?`,
    [tokenHash, tokenHash]
  );

  if (!row) {
    return { ok: false, status: 404, error: 'Security approval request not found.' };
  }

  const tokenBoundAction: 'approve' | 'reject' =
    row.approve_token_hash === tokenHash ? 'approve' : 'reject';
  if (tokenBoundAction !== params.action) {
    return { ok: false, status: 400, error: 'Token does not authorize the requested action.' };
  }

  if (row.status !== 'pending') {
    return {
      ok: false,
      status: 409,
      error: `This login request was already ${row.status}.`,
    };
  }

  if (row.expires_at <= now) {
    // Expire ONLY this session's approval request; never permanently lock future fresh logins
    await db.batch([
      {
        sql: `UPDATE admin_login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'`,
        params: [row.id],
      },
      {
        sql: `UPDATE admin_session_verifications
              SET device_approval_status = 'expired', updated_at = ?
              WHERE session_id = ?`,
        params: [now, row.session_id],
      },
    ]);
    return {
      ok: false,
      status: 410,
      error:
        'This approval request has expired. Its login session remains locked; sign in again to start a new request.',
    };
  }

  const sess = await db.get<{ id: string }>(
    `SELECT id FROM session WHERE id = ? AND expiresAt > ?`,
    [row.session_id, now]
  );
  if (!sess) {
    await db.batch([
      {
        sql: `UPDATE admin_login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'`,
        params: [row.id],
      },
      {
        sql: `UPDATE admin_session_verifications
              SET device_approval_status = 'expired', updated_at = ?
              WHERE session_id = ?`,
        params: [now, row.session_id],
      },
    ]);
    return {
      ok: false,
      status: 410,
      error: 'The login session for this request has expired. Sign in again to start a new request.',
    };
  }

  const userRow = await db.get<{ id: string; email: string; role: string }>(
    `SELECT id, email, role FROM user WHERE id = ?`,
    [row.user_id]
  );

  const nextStatus = params.action === 'approve' ? 'approved' : 'rejected';
  const claimRes = await db.run(
    `UPDATE admin_login_approvals
     SET status = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    [nextStatus, now, params.actorLabel || 'gmail_email_action', row.id, now]
  );
  if (claimRes.changes === 0) {
    return { ok: false, status: 409, error: 'This security request has already been processed or expired.' };
  }

  if (params.action === 'approve') {
    await db.batch([
      {
        sql: `UPDATE admin_session_verifications
              SET device_approval_status = 'approved',
                  sec_password_verified_at = NULL,
                  sec_password_expires_at = NULL,
                  updated_at = ?
              WHERE session_id = ? AND user_id = ?`,
        params: [now, row.session_id, row.user_id],
      },
      {
        sql: `INSERT INTO admin_trusted_devices (
                id, user_id, device_token_hash, device_label, trusted_ip, approx_location,
                is_active, approved_via, revoked_at, revoked_by, first_seen_at, last_seen_at
              ) VALUES (?, ?, ?, ?, ?, ?, 1, 'gmail_approval', NULL, NULL, ?, ?)
              ON CONFLICT(user_id, device_token_hash, trusted_ip) DO UPDATE SET
                device_label = excluded.device_label,
                approx_location = excluded.approx_location,
                is_active = 1,
                approved_via = 'gmail_approval',
                revoked_at = NULL,
                revoked_by = NULL,
                last_seen_at = excluded.last_seen_at`,
        params: [
          `atd_${randomUuid()}`,
          row.user_id,
          row.device_token_hash,
          row.device_summary,
          row.ip_address,
          row.approx_location,
          now,
          now,
        ],
      },
      {
        sql: `UPDATE security_events SET status = 'confirmed_by_user', resolved_at = ? WHERE event_ref = ?`,
        params: [now, row.event_ref || ''],
      },
    ]);

    await writeAuditLog(db, {
      actorId: row.user_id,
      actorEmail: userRow?.email ?? null,
      actorRole: userRow?.role ?? null,
      action: 'ADMIN_LOGIN_APPROVED_VIA_EMAIL',
      targetType: 'session',
      targetId: row.session_id,
      details: { approvalId: row.id, eventRef: row.event_ref, ip: row.ip_address },
    });

    try {
      const cfg = await getEffectiveEmailConfig(db, env);
      const recipient = cfg.adminNotificationEmail || userRow?.email;
      if (recipient) {
        const html = renderSelloraEmailHtml({
          title: 'Admin Access Request Approved',
          greeting: 'Store Administration Notice,',
          intro:
            'You approved the pending administrative access request. The admin may now proceed after verifying the separate Admin Security Password.',
          detailsRows: [
            { label: 'Event Reference', value: row.event_ref || row.id },
            { label: 'Account', value: userRow?.email || row.user_id },
            { label: 'Device', value: row.device_summary },
            { label: 'IP Address', value: row.ip_address },
            { label: 'Approved At (WAT)', value: formatLagosDate(now) },
          ],
        });
        const queued = await queueEmailEvent(db, {
          idempotencyKey: `adm_apv_outcome:${row.id}:approved`,
          recipientEmail: recipient,
          recipientType: 'admin',
          notificationType: 'security_admin_approval_outcome',
          subject: `[SELLORA Security] Admin Access Approved (${row.event_ref || row.id})`,
          htmlBody: html,
        });
        if (queued.queued && queued.eventId) {
          await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
        }
      }
    } catch {
      // non-fatal
    }

    return {
      ok: true,
      status: 200,
      decision: 'approved',
      approvalId: row.id,
      sessionId: row.session_id,
      eventRef: row.event_ref,
    };
  }

  // REJECT: Keep request locked AND terminate only that pending login session
  await db.batch([
    {
      sql: `UPDATE admin_session_verifications
            SET device_approval_status = 'rejected',
                sec_password_verified_at = NULL,
                sec_password_expires_at = NULL,
                updated_at = ?
            WHERE session_id = ?`,
      params: [now, row.session_id],
    },
    {
      sql: `DELETE FROM session WHERE id = ?`,
      params: [row.session_id],
    },
    {
      sql: `UPDATE security_events
            SET status = 'disputed_by_user', severity = 'critical', risk_level = 'high'
            WHERE event_ref = ?`,
      params: [row.event_ref || ''],
    },
  ]);

  await writeAuditLog(db, {
    actorId: row.user_id,
    actorEmail: userRow?.email ?? null,
    actorRole: userRow?.role ?? null,
    action: 'ADMIN_LOGIN_REJECTED_VIA_EMAIL',
    targetType: 'session',
    targetId: row.session_id,
    details: { approvalId: row.id, eventRef: row.event_ref, ip: row.ip_address },
  });

  try {
    const cfg = await getEffectiveEmailConfig(db, env);
    const recipient = cfg.adminNotificationEmail || userRow?.email;
    if (recipient) {
      const html = renderSelloraEmailHtml({
        title: 'Admin Access Request Rejected & Session Terminated',
        greeting: 'Store Administration Security Alert,',
        intro:
          'You rejected the pending administrative sign-in request. That login session was immediately terminated and denied dashboard access. If this attempt was unauthorized, rotate your account password and Admin Security Password right away.',
        detailsRows: [
          { label: 'Event Reference', value: row.event_ref || row.id },
          { label: 'Account', value: userRow?.email || row.user_id },
          { label: 'Device', value: row.device_summary },
          { label: 'IP Address', value: row.ip_address },
          { label: 'Rejected At (WAT)', value: formatLagosDate(now) },
        ],
      });
      const queued = await queueEmailEvent(db, {
        idempotencyKey: `adm_apv_outcome:${row.id}:rejected`,
        recipientEmail: recipient,
        recipientType: 'admin',
        notificationType: 'security_admin_approval_outcome',
        subject: `[SELLORA Security Alert] Admin Access Rejected (${row.event_ref || row.id})`,
        htmlBody: html,
      });
      if (queued.queued && queued.eventId) {
        await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
      }
    }
  } catch {
    // non-fatal
  }

  return {
    ok: true,
    status: 200,
    decision: 'rejected',
    approvalId: row.id,
    sessionId: row.session_id,
    eventRef: row.event_ref,
  };
}

/**
 * Allows an already-unlocked owner/admin on a trusted session to approve or reject a pending login request directly from Admin Settings.
 */
export async function decidePendingApprovalById(
  db: SelloraDb,
  env: EnvLike,
  params: {
    approvalId: string;
    action: 'approve' | 'reject';
    actorId: string;
    actorEmail: string;
    actorRole: string;
    ip: string;
  }
): Promise<{ ok: boolean; status: number; decision?: 'approved' | 'rejected'; error?: string }> {
  const now = new Date().toISOString();
  const row = await db.get<{
    id: string;
    session_id: string;
    user_id: string;
    event_ref: string | null;
    device_token_hash: string;
    device_summary: string;
    ip_address: string;
    approx_location: string | null;
    status: string;
    expires_at: string;
  }>(`SELECT * FROM admin_login_approvals WHERE id = ?`, [params.approvalId]);

  if (!row) {
    return { ok: false, status: 404, error: 'Approval request not found.' };
  }
  if (params.actorRole !== 'owner' && row.user_id !== params.actorId) {
    return { ok: false, status: 403, error: 'You may only decide your own approval requests.' };
  }
  if (row.status !== 'pending') {
    return { ok: false, status: 409, error: `Request was already ${row.status}.` };
  }
  if (row.expires_at <= now) {
    await db.batch([
      {
        sql: `UPDATE admin_login_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'`,
        params: [row.id],
      },
      {
        sql: `UPDATE admin_session_verifications SET device_approval_status = 'expired', updated_at = ? WHERE session_id = ?`,
        params: [now, row.session_id],
      },
    ]);
    return { ok: false, status: 410, error: 'Approval request has expired; a fresh login is required.' };
  }

  const nextStatus = params.action === 'approve' ? 'approved' : 'rejected';
  const claim = await db.run(
    `UPDATE admin_login_approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`,
    [nextStatus, now, `dashboard:${params.actorEmail}`, row.id]
  );
  if (claim.changes === 0) {
    return { ok: false, status: 409, error: 'Approval request already processed.' };
  }

  if (params.action === 'approve') {
    await db.batch([
      {
        sql: `UPDATE admin_session_verifications
              SET device_approval_status = 'approved',
                  sec_password_verified_at = NULL,
                  sec_password_expires_at = NULL,
                  updated_at = ?
              WHERE session_id = ? AND user_id = ?`,
        params: [now, row.session_id, row.user_id],
      },
      {
        sql: `INSERT INTO admin_trusted_devices (
                id, user_id, device_token_hash, device_label, trusted_ip, approx_location,
                is_active, approved_via, revoked_at, revoked_by, first_seen_at, last_seen_at
              ) VALUES (?, ?, ?, ?, ?, ?, 1, 'owner_dashboard', NULL, NULL, ?, ?)
              ON CONFLICT(user_id, device_token_hash, trusted_ip) DO UPDATE SET
                device_label = excluded.device_label,
                approx_location = excluded.approx_location,
                is_active = 1,
                approved_via = 'owner_dashboard',
                revoked_at = NULL,
                revoked_by = NULL,
                last_seen_at = excluded.last_seen_at`,
        params: [
          `atd_${randomUuid()}`,
          row.user_id,
          row.device_token_hash,
          row.device_summary,
          row.ip_address,
          row.approx_location,
          now,
          now,
        ],
      },
      {
        sql: `UPDATE security_events SET status = 'confirmed_by_user', resolved_at = ? WHERE event_ref = ?`,
        params: [now, row.event_ref || ''],
      },
    ]);
  } else {
    await db.batch([
      {
        sql: `UPDATE admin_session_verifications
              SET device_approval_status = 'rejected',
                  sec_password_verified_at = NULL,
                  sec_password_expires_at = NULL,
                  updated_at = ?
              WHERE session_id = ?`,
        params: [now, row.session_id],
      },
      {
        sql: `DELETE FROM session WHERE id = ?`,
        params: [row.session_id],
      },
      {
        sql: `UPDATE security_events SET status = 'disputed_by_user', severity = 'critical', risk_level = 'high' WHERE event_ref = ?`,
        params: [row.event_ref || ''],
      },
    ]);
  }

  await writeAuditLog(db, {
    actorId: params.actorId,
    actorEmail: params.actorEmail,
    actorRole: params.actorRole,
    action: params.action === 'approve' ? 'ADMIN_LOGIN_APPROVED_VIA_DASHBOARD' : 'ADMIN_LOGIN_REJECTED_VIA_DASHBOARD',
    targetType: 'session',
    targetId: row.session_id,
    details: { approvalId: row.id, ip: row.ip_address },
    ipAddress: params.ip,
  });

  void env;
  return { ok: true, status: 200, decision: nextStatus };
}
