import { randomHex, randomUuid, sha256Hex } from './crypto';
import type { SelloraDb } from './db';
import {
  dispatchSingleEmailEvent,
  getEffectiveEmailConfig,
  queueEmailEvent,
  renderSelloraEmailHtml,
  type EmailEnvConfig,
} from './email';
import { getTrustedClientIp, recordSecurityEvent, writeAuditLog } from './security';

export interface GeoApprox {
  country: string | null;
  city: string | null;
  region: string | null;
  label: string;
}

export function extractApproxLocation(headers: Headers): GeoApprox {
  const country = headers.get('cf-ipcountry')?.trim() || null;
  const city = headers.get('cf-ipcity')?.trim() || null;
  const region = headers.get('cf-region')?.trim() || null;
  const parts = [city, region, country].filter(Boolean);
  return {
    country,
    city,
    region,
    label: parts.length > 0 ? parts.join(', ') : 'Approximate location unavailable',
  };
}

export function parseDeviceSummary(userAgent: string | null | undefined): {
  browser: string;
  os: string;
  summary: string;
  normalizedKey: string;
} {
  const ua = (userAgent || '').trim();
  if (!ua) {
    return {
      browser: 'Unknown Client',
      os: 'Unknown Device',
      summary: 'Unknown Client on Unknown Device',
      normalizedKey: 'unknown|unknown',
    };
  }

  let browser = 'Browser';
  if (/edg\//i.test(ua)) browser = 'Microsoft Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/chrome|crios/i.test(ua) && !/edg/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua) && !/chrome|crios/i.test(ua)) browser = 'Safari';
  else if (/curl|node|undici|fetch/i.test(ua)) browser = 'Automated Client';

  let os = 'Unknown OS';
  if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  return {
    browser,
    os,
    summary: `${browser} on ${os}`,
    normalizedKey: `${browser.toLowerCase()}|${os.toLowerCase()}`,
  };
}

export async function computeDeviceHash(userId: string, userAgent: string | null | undefined): Promise<string> {
  const parsed = parseDeviceSummary(userAgent);
  return sha256Hex(`${userId}::${parsed.normalizedKey}`);
}

export async function recordLoginAttemptAndMonitor(
  db: SelloraDb,
  env: EmailEnvConfig & { runtime?: 'worker' | 'node'; trustedProxy?: boolean; ownerEmail?: string },
  params: {
    headers: Headers;
    userId?: string | null;
    email: string;
    userName?: string | null;
    userRole?: string | null;
    authMethod: 'email_password' | 'google_oauth';
    outcome: 'success' | 'failed' | 'locked';
    sessionId?: string | null;
  }
): Promise<{
  loginId: string;
  isNewDevice: boolean;
  isUnusual: boolean;
  eventRef: string | null;
  confirmUrl: string | null;
  disputeUrl: string | null;
}> {
  const ua = params.headers.get('user-agent') || '';
  const ip = getTrustedClientIp(params.headers, env);
  const geo = extractApproxLocation(params.headers);
  const device = parseDeviceSummary(ua);
  const now = new Date().toISOString();
  const loginId = `lgn_${randomUuid()}`;
  const normEmail = params.email.trim().toLowerCase();
  const deviceHash = await computeDeviceHash(params.userId || normEmail, ua);

  if (params.outcome !== 'success' || !params.userId) {
    await db
      .run(
        `INSERT INTO login_history (
          id, user_id, email, auth_method, outcome, is_new_device, is_unusual,
          device_hash, device_summary, ip_address, approx_location, risk_score, session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          loginId,
          params.userId ?? null,
          normEmail,
          params.authMethod,
          params.outcome,
          deviceHash,
          device.summary,
          ip,
          geo.label,
          params.outcome === 'locked' ? 75 : 30,
          now,
        ]
      )
      .catch(() => {});

    return {
      loginId,
      isNewDevice: false,
      isUnusual: false,
      eventRef: null,
      confirmUrl: null,
      disputeUrl: null,
    };
  }

  // Evaluate prior known devices for this authenticated user
  const existingDevices = await db.all<{
    id: string;
    device_hash: string;
    approx_location: string | null;
    last_ip: string | null;
    trusted: number;
  }>(
    `SELECT id, device_hash, approx_location, last_ip, trusted FROM known_user_devices WHERE user_id = ?`,
    [params.userId]
  );

  const matchedKnown = existingDevices.find((d) => d.device_hash === deviceHash);
  const hasPriorDevices = existingDevices.length > 0;
  const isNewDevice = hasPriorDevices && !matchedKnown;

  // Detect country shift ONLY when prior country is known and clearly changed (mobile carrier IP/city drift alone does not trigger lockout)
  const priorCountries = new Set(
    existingDevices
      .map((d) => d.approx_location?.split(',').pop()?.trim())
      .filter((c): c is string => Boolean(c && c !== 'Approximate location unavailable'))
  );
  const countryShifted =
    Boolean(geo.country) && priorCountries.size > 0 && !priorCountries.has(geo.country!);

  const isPrivileged = params.userRole === 'owner' || params.userRole === 'admin';
  const isUnusual = isNewDevice || countryShifted;
  const riskScore = (isNewDevice ? 45 : 0) + (countryShifted ? 35 : 0) + (isPrivileged && isUnusual ? 15 : 0);

  await db.run(
    `INSERT INTO known_user_devices (
      id, user_id, device_hash, device_summary, approx_location, last_ip, trusted, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_hash) DO UPDATE SET
      approx_location = excluded.approx_location,
      last_ip = excluded.last_ip,
      last_seen_at = excluded.last_seen_at`,
    [
      `dev_${randomUuid()}`,
      params.userId,
      deviceHash,
      device.summary,
      geo.label,
      ip,
      isNewDevice ? 0 : 1,
      now,
      now,
    ]
  );

  await db.run(
    `INSERT INTO login_history (
      id, user_id, email, auth_method, outcome, is_new_device, is_unusual,
      device_hash, device_summary, ip_address, approx_location, risk_score, session_id, created_at
    ) VALUES (?, ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      loginId,
      params.userId,
      normEmail,
      params.authMethod,
      isNewDevice ? 1 : 0,
      isUnusual ? 1 : 0,
      deviceHash,
      device.summary,
      ip,
      geo.label,
      riskScore,
      params.sessionId ?? null,
      now,
    ]
  );

  let eventRef: string | null = null;
  let confirmUrl: string | null = null;
  let disputeUrl: string | null = null;

  if (isUnusual) {
    eventRef = await recordSecurityEvent(db, {
      userId: params.userId,
      email: normEmail,
      eventCategory: isNewDevice ? 'new_device_login' : 'unusual_location_login',
      severity: isPrivileged ? 'high' : 'medium',
      riskLevel: riskScore >= 60 ? 'high' : 'medium',
      status: 'recorded',
      ipAddress: ip,
      approxLocation: geo.label,
      deviceSummary: device.summary,
      userAgent: ua,
      metadata: {
        loginId,
        authMethod: params.authMethod,
        isNewDevice,
        countryShifted,
      },
    });

    // Generate single-use CSPRNG verification tokens (store ONLY SHA-256 hashes in DB)
    const confirmToken = randomHex(32);
    const disputeToken = randomHex(32);
    const [confirmHash, disputeHash] = await Promise.all([
      sha256Hex(confirmToken),
      sha256Hex(disputeToken),
    ]);
    const expiresAt = new Date(Date.now() + 48 * 3_600_000).toISOString();

    await db.batch([
      {
        sql: `INSERT INTO login_verification_tokens (
          id, login_id, event_ref, user_id, device_hash, token_hash, action, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'confirm', ?, ?)`,
        params: [
          `lvt_${randomUuid()}`,
          loginId,
          eventRef,
          params.userId,
          deviceHash,
          confirmHash,
          expiresAt,
          now,
        ],
      },
      {
        sql: `INSERT INTO login_verification_tokens (
          id, login_id, event_ref, user_id, device_hash, token_hash, action, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'dispute', ?, ?)`,
        params: [
          `lvt_${randomUuid()}`,
          loginId,
          eventRef,
          params.userId,
          deviceHash,
          disputeHash,
          expiresAt,
          now,
        ],
      },
    ]);

    const cfg = await getEffectiveEmailConfig(db, env);
    confirmUrl = `${cfg.resolvedAppUrl}/api/security/login-response?action=confirm&token=${confirmToken}`;
    disputeUrl = `${cfg.resolvedAppUrl}/api/security/login-response?action=dispute&token=${disputeToken}`;

    try {
      const alertHtml = renderSelloraEmailHtml({
        title: 'New Device Sign-In Alert',
        greeting: `Hello ${params.userName || 'SELLORA User'},`,
        intro:
          'A sign-in was just completed on your SELLORA account from a new device or unusual location. Please confirm whether this activity was yours. (Note: approximate location from mobile or VPN networks can occasionally vary.)',
        detailsRows: [
          { label: 'Event Reference', value: eventRef },
          { label: 'Device & Browser', value: device.summary },
          { label: 'Approx. Location', value: geo.label },
          { label: 'IP Address', value: ip },
          { label: 'Time (UTC)', value: now },
        ],
        ctaLabel: 'This was me',
        ctaUrl: confirmUrl,
        footerNote: `If this was NOT you, immediately revoke all sessions here: ${disputeUrl}`,
      });

      const queued = await queueEmailEvent(db, {
        idempotencyKey: `sec_login:${loginId}`,
        recipientEmail: normEmail,
        recipientType: params.userRole === 'owner' || params.userRole === 'admin' ? 'admin' : 'customer',
        notificationType: 'security_new_device_login',
        subject: `[SELLORA Security] New sign-in detected (${eventRef})`,
        htmlBody: alertHtml,
      });
      if (queued.queued && queued.eventId) {
        await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
      }
    } catch {
      // Security notification failure must never crash login recording
    }
  }

  return { loginId, isNewDevice, isUnusual, eventRef, confirmUrl, disputeUrl };
}

export async function processLoginVerificationToken(
  db: SelloraDb,
  env: EmailEnvConfig,
  rawToken: string,
  expectedAction?: 'confirm' | 'dispute'
): Promise<{
  ok: boolean;
  action?: 'confirm' | 'dispute';
  eventRef?: string | null;
  revokedSessions?: number;
  error?: string;
}> {
  const token = (rawToken || '').trim();
  if (token.length < 32) {
    return { ok: false, error: 'Invalid verification token.' };
  }

  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();

  const row = await db.get<{
    id: string;
    login_id: string;
    event_ref: string | null;
    user_id: string;
    device_hash: string;
    action: 'confirm' | 'dispute';
    expires_at: string;
    used_at: string | null;
  }>(
    `SELECT id, login_id, event_ref, user_id, device_hash, action, expires_at, used_at
     FROM login_verification_tokens WHERE token_hash = ?`,
    [tokenHash]
  );

  if (!row) {
    return { ok: false, error: 'Security verification link is invalid.' };
  }
  if (expectedAction && row.action !== expectedAction) {
    return { ok: false, error: 'Verification action does not match this link.' };
  }
  if (row.used_at) {
    return { ok: false, error: 'This security verification link has already been used.' };
  }
  if (row.expires_at < now) {
    return { ok: false, error: 'This security verification link has expired.' };
  }

  // Mark BOTH paired tokens for this login_id as used atomically so neither link can be replayed
  const consumeRes = await db.run(
    `UPDATE login_verification_tokens SET used_at = ? WHERE login_id = ? AND used_at IS NULL`,
    [now, row.login_id]
  );
  if (consumeRes.changes === 0) {
    return { ok: false, error: 'This security verification link has already been used.' };
  }

  const userRow = await db.get<{ id: string; email: string; name: string; role: string }>(
    `SELECT id, email, name, role FROM user WHERE id = ?`,
    [row.user_id]
  );

  if (row.action === 'confirm') {
    await db.batch([
      {
        sql: `UPDATE known_user_devices SET trusted = 1, last_seen_at = ? WHERE user_id = ? AND device_hash = ?`,
        params: [now, row.user_id, row.device_hash],
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
      action: 'LOGIN_ALERT_CONFIRMED',
      targetType: 'security_event',
      targetId: row.event_ref ?? row.login_id,
    });

    return { ok: true, action: 'confirm', eventRef: row.event_ref };
  }

  // DISPUTE ("This wasn't me"): immediately revoke ALL active sessions for the user & untrust device
  const sessionDel = await db.run(`DELETE FROM session WHERE userId = ?`, [row.user_id]);
  await db.batch([
    {
      sql: `DELETE FROM known_user_devices WHERE user_id = ? AND device_hash = ?`,
      params: [row.user_id, row.device_hash],
    },
    {
      sql: `UPDATE login_history SET outcome = 'disputed', is_unusual = 1 WHERE id = ?`,
      params: [row.login_id],
    },
    {
      sql: `UPDATE security_events SET status = 'disputed_by_user', severity = 'critical', risk_level = 'high' WHERE event_ref = ?`,
      params: [row.event_ref || ''],
    },
  ]);

  await writeAuditLog(db, {
    actorId: row.user_id,
    actorEmail: userRow?.email ?? null,
    actorRole: userRow?.role ?? null,
    action: 'LOGIN_ALERT_DISPUTED_SESSIONS_REVOKED',
    targetType: 'user',
    targetId: row.user_id,
    details: { eventRef: row.event_ref, revokedSessions: sessionDel.changes },
  });

  // Notify store owner when a privileged or customer account disputes unrecognized sign-in
  try {
    const cfg = await getEffectiveEmailConfig(db, env);
    if (cfg.adminNotificationEmail) {
      const html = renderSelloraEmailHtml({
        title: 'Urgent: Unrecognized Sign-In Disputed',
        greeting: 'Store Owner Security Notice,',
        intro:
          'A user clicked "This wasn\'t me" on a sign-in alert. All active sessions for that account have been terminated and a password reset is recommended.',
        detailsRows: [
          { label: 'Account', value: userRow?.email || row.user_id },
          { label: 'Event Reference', value: row.event_ref || 'N/A' },
          { label: 'Sessions Terminated', value: String(sessionDel.changes) },
        ],
      });
      const queued = await queueEmailEvent(db, {
        idempotencyKey: `sec_dispute:${row.login_id}`,
        recipientEmail: cfg.adminNotificationEmail,
        recipientType: 'admin',
        notificationType: 'security_disputed_login',
        subject: `[SELLORA Security Alert] Disputed sign-in (${row.event_ref || 'URGENT'})`,
        htmlBody: html,
      });
      if (queued.queued && queued.eventId) {
        await dispatchSingleEmailEvent(db, env, queued.eventId).catch(() => {});
      }
    }
  } catch {
    // Non-fatal if mail provider unavailable
  }

  return {
    ok: true,
    action: 'dispute',
    eventRef: row.event_ref,
    revokedSessions: sessionDel.changes,
  };
}
