import { randomUuid } from './crypto';
import type { SelloraDb } from './db';

export interface EmailEnvConfig {
  brevoApiKey?: string;
  brevoFromEmail?: string;
  brevoFromName?: string;
  adminNotificationEmail?: string;
  appUrl?: string;
}

export interface EmailSettingsRecord {
  adminNotificationEmail: string;
  fromEmail: string;
  fromName: string;
  testEmailRecipient: string;
  adminEvents: Record<string, boolean>;
  customerEvents: Record<string, boolean>;
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettingsRecord = {
  adminNotificationEmail: '',
  fromEmail: '',
  fromName: 'SELLORA',
  testEmailRecipient: '',
  adminEvents: {
    new_order: true,
    new_customer: true,
    payment_evidence_submitted: true,
    payment_verified: true,
    payment_rejected: true,
    order_received: true,
    order_processing: true,
    order_ready_for_dispatch: true,
    order_out_for_delivery: true,
    order_delivered: true,
    order_cancelled: true,
    refund_confirmed: true,
    attention_required: true,
  },
  customerEvents: {
    order_placed: true,
    order_received: true,
    payment_evidence_submitted: true,
    payment_verified: true,
    payment_rejected: true,
    order_processing: true,
    order_ready_for_dispatch: true,
    order_out_for_delivery: true,
    order_delivered: true,
    order_cancelled: true,
    refund_confirmed: true,
    welcome: true,
    auth_verification: true,
    auth_password_reset: true,
  },
};

export async function getEffectiveEmailConfig(
  db: SelloraDb,
  env: EmailEnvConfig
): Promise<EmailSettingsRecord & { hasApiKey: boolean; resolvedAppUrl: string }> {
  const row = await db.get<{ value_json: string }>(
    `SELECT value_json FROM store_settings WHERE key = 'email'`
  );
  let stored: Partial<EmailSettingsRecord> = {};
  if (row?.value_json) {
    try {
      stored = JSON.parse(row.value_json);
    } catch {
      stored = {};
    }
  }
  return {
    adminNotificationEmail:
      (stored.adminNotificationEmail || '').trim() ||
      env.adminNotificationEmail ||
      'olarindevictor3@gmail.com',
    fromEmail: stored.fromEmail || env.brevoFromEmail || '',
    fromName: stored.fromName || env.brevoFromName || 'SELLORA',
    testEmailRecipient:
      (stored.testEmailRecipient || '').trim() ||
      (stored.adminNotificationEmail || '').trim() ||
      env.adminNotificationEmail ||
      'olarindevictor3@gmail.com',
    adminEvents: { ...DEFAULT_EMAIL_SETTINGS.adminEvents, ...(stored.adminEvents || {}) },
    customerEvents: { ...DEFAULT_EMAIL_SETTINGS.customerEvents, ...(stored.customerEvents || {}) },
    hasApiKey: Boolean(env.brevoApiKey && env.brevoApiKey.trim().length > 0),
    resolvedAppUrl: (env.appUrl || 'http://localhost:3000').replace(/\/+$/, ''),
  };
}

export function renderSelloraEmailHtml(params: {
  title: string;
  greeting: string;
  intro: string;
  orderNumber?: string;
  statusLabel?: string;
  detailsRows?: Array<{ label: string; value: string }>;
  ctaLabel?: string;
  ctaUrl?: string;
  footerNote?: string;
}): string {
  const rowsHtml = (params.detailsRows || [])
    .map(
      (r) => `
      <tr>
        <td style="padding:8px 0;color:#64748B;font-size:13px;border-bottom:1px solid #E2E8F0;">${escapeHtml(r.label)}</td>
        <td style="padding:8px 0;color:#1E293B;font-size:13px;font-weight:600;text-align:right;border-bottom:1px solid #E2E8F0;">${escapeHtml(r.value)}</td>
      </tr>`
    )
    .join('');

  const ctaHtml =
    params.ctaLabel && params.ctaUrl
      ? `<div style="margin:24px 0 8px;">
           <a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background:#172554;color:#B7F36B;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;">
             ${escapeHtml(params.ctaLabel)}
           </a>
         </div>`
      : '';

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F7F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1E293B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background:#172554;padding:20px 28px;">
              <span style="color:#FFFFFF;font-size:20px;font-weight:800;letter-spacing:0.08em;">SELLORA</span>
              <span style="color:#B7F36B;font-size:12px;margin-left:10px;">Commerce without limits.</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <h1 style="margin:0 0 12px;font-size:20px;color:#172554;">${escapeHtml(params.title)}</h1>
              <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">${escapeHtml(params.greeting)}</p>
              <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155;">${escapeHtml(params.intro)}</p>
              ${
                params.orderNumber || params.statusLabel
                  ? `<div style="background:#F5F7F4;border:1px solid #E2E8F0;border-radius:8px;padding:14px 16px;margin-bottom:18px;">
                      ${params.orderNumber ? `<div style="font-size:12px;color:#64748B;">Order Number</div><div style="font-size:16px;font-weight:700;color:#172554;font-family:monospace;">${escapeHtml(params.orderNumber)}</div>` : ''}
                      ${params.statusLabel ? `<div style="font-size:12px;color:#64748B;margin-top:8px;">Current Status</div><div style="font-size:14px;font-weight:600;color:#1E293B;">${escapeHtml(params.statusLabel)}</div>` : ''}
                    </div>`
                  : ''
              }
              ${rowsHtml ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rowsHtml}</table>` : ''}
              ${ctaHtml}
              <p style="margin:24px 0 0;font-size:12px;color:#64748B;line-height:1.5;">
                ${escapeHtml(params.footerNote || 'Thank you for shopping with SELLORA. Replies or inquiries can be submitted through our Track Order and Support pages.')}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export async function queueEmailEvent(
  db: SelloraDb,
  params: {
    idempotencyKey: string;
    orderId?: string | null;
    orderNumber?: string | null;
    recipientEmail: string;
    recipientType: 'customer' | 'admin' | 'test';
    notificationType: string;
    subject: string;
    htmlBody: string;
  }
): Promise<{ queued: boolean; eventId: string | null }> {
  const email = params.recipientEmail.trim().toLowerCase();
  if (!isValidEmail(email)) {
    return { queued: false, eventId: null };
  }

  const existing = await db.get<{ event_id: string }>(
    `SELECT event_id FROM email_notification_events WHERE idempotency_key = ?`,
    [params.idempotencyKey]
  );
  if (existing) {
    return { queued: false, eventId: existing.event_id };
  }

  const eventId = `evt_${randomUuid()}`;
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO email_notification_events (
      event_id, idempotency_key, order_id, order_number, recipient_email,
      recipient_type, notification_type, subject, html_body, status,
      attempt_count, max_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 3, ?, ?)`,
    [
      eventId,
      params.idempotencyKey,
      params.orderId ?? null,
      params.orderNumber ?? null,
      email,
      params.recipientType,
      params.notificationType,
      params.subject,
      params.htmlBody,
      now,
      now,
    ]
  );

  return { queued: true, eventId };
}

export async function dispatchSingleEmailEvent(
  db: SelloraDb,
  env: EmailEnvConfig,
  eventId: string
): Promise<{ ok: boolean; status: string; messageId?: string; error?: string }> {
  const event = await db.get<{
    event_id: string;
    recipient_email: string;
    subject: string;
    html_body: string;
    status: string;
    attempt_count: number;
    max_attempts: number;
  }>(`SELECT * FROM email_notification_events WHERE event_id = ?`, [eventId]);

  if (!event) return { ok: false, status: 'not_found', error: 'Event not found' };
  if (event.status === 'accepted_by_provider' || event.status === 'sent' || event.status === 'delivered') {
    return { ok: true, status: event.status };
  }

  const config = await getEffectiveEmailConfig(db, env);
  const nextAttempt = event.attempt_count + 1;
  const now = new Date().toISOString();

  await db.run(
    `UPDATE email_notification_events SET status = 'pending', attempt_count = ?, updated_at = ? WHERE event_id = ?`,
    [nextAttempt, now, eventId]
  );

  if (!env.brevoApiKey || !config.fromEmail) {
    const errMsg = !env.brevoApiKey
      ? 'BREVO_API_KEY is not configured in server environment.'
      : 'Verified sender email (BREVO_FROM_EMAIL) is not configured.';
    const finalStatus = nextAttempt >= event.max_attempts ? 'failed' : 'queued';
    const retryAt =
      finalStatus === 'queued'
        ? new Date(Date.now() + nextAttempt * 60_000).toISOString()
        : null;

    await db.run(
      `INSERT INTO email_delivery_attempts (id, event_id, attempt_number, status, error_message, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`att_${randomUuid()}`, eventId, nextAttempt, finalStatus, errMsg, now]
    );
    await db.run(
      `UPDATE email_notification_events SET status = ?, last_error = ?, next_retry_at = ?, updated_at = ? WHERE event_id = ?`,
      [finalStatus, errMsg, retryAt, now, eventId]
    );
    return { ok: false, status: finalStatus, error: errMsg };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': env.brevoApiKey,
      },
      body: JSON.stringify({
        sender: {
          name: config.fromName || 'SELLORA',
          email: config.fromEmail,
        },
        to: [{ email: event.recipient_email }],
        subject: event.subject,
        htmlContent: event.html_body,
      }),
    });

    const rawText = await response.text();
    let parsed: { messageId?: string; message?: string } = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {};
    }

    if (response.ok) {
      const msgId = parsed.messageId || null;
      await db.run(
        `INSERT INTO email_delivery_attempts (id, event_id, attempt_number, status, provider_message_id, http_status, attempted_at)
         VALUES (?, ?, ?, 'accepted_by_provider', ?, ?, ?)`,
        [`att_${randomUuid()}`, eventId, nextAttempt, msgId, response.status, now]
      );
      await db.run(
        `UPDATE email_notification_events
         SET status = 'accepted_by_provider', provider_message_id = ?, last_error = NULL, next_retry_at = NULL, updated_at = ?
         WHERE event_id = ?`,
        [msgId, now, eventId]
      );
      return { ok: true, status: 'accepted_by_provider', messageId: msgId || undefined };
    }

    const errMsg = parsed.message || `Brevo API returned HTTP ${response.status}`;
    const isPermanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    const finalStatus = isPermanent || nextAttempt >= event.max_attempts ? 'failed' : 'queued';
    const retryAt =
      finalStatus === 'queued'
        ? new Date(Date.now() + Math.pow(2, nextAttempt) * 30_000).toISOString()
        : null;

    await db.run(
      `INSERT INTO email_delivery_attempts (id, event_id, attempt_number, status, http_status, error_message, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`att_${randomUuid()}`, eventId, nextAttempt, finalStatus, response.status, errMsg, now]
    );
    await db.run(
      `UPDATE email_notification_events SET status = ?, last_error = ?, next_retry_at = ?, updated_at = ? WHERE event_id = ?`,
      [finalStatus, errMsg, retryAt, now, eventId]
    );
    return { ok: false, status: finalStatus, error: errMsg };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Network error calling Brevo API';
    const finalStatus = nextAttempt >= event.max_attempts ? 'failed' : 'queued';
    const retryAt =
      finalStatus === 'queued'
        ? new Date(Date.now() + Math.pow(2, nextAttempt) * 30_000).toISOString()
        : null;

    await db.run(
      `INSERT INTO email_delivery_attempts (id, event_id, attempt_number, status, error_message, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`att_${randomUuid()}`, eventId, nextAttempt, finalStatus, errMsg, now]
    );
    await db.run(
      `UPDATE email_notification_events SET status = ?, last_error = ?, next_retry_at = ?, updated_at = ? WHERE event_id = ?`,
      [finalStatus, errMsg, retryAt, now, eventId]
    );
    return { ok: false, status: finalStatus, error: errMsg };
  }
}

export async function processEmailOutbox(db: SelloraDb, env: EmailEnvConfig, limit = 10): Promise<number> {
  const now = new Date().toISOString();
  const due = await db.all<{ event_id: string }>(
    `SELECT event_id FROM email_notification_events
     WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY created_at ASC LIMIT ?`,
    [now, limit]
  );
  let processed = 0;
  for (const row of due) {
    await dispatchSingleEmailEvent(db, env, row.event_id);
    processed++;
  }
  return processed;
}

export async function triggerOrderNotifications(
  db: SelloraDb,
  env: EmailEnvConfig,
  params: {
    eventKey: string;
    orderId: string;
    orderNumber: string;
    customerName: string;
    customerEmail: string;
    statusLabel: string;
    totalFormatted: string;
    deliveryLocation?: string;
    extraRows?: Array<{ label: string; value: string }>;
    customerTitle: string;
    customerIntro: string;
    adminTitle: string;
    adminIntro: string;
    uniqueSuffix?: string;
  }
): Promise<void> {
  const cfg = await getEffectiveEmailConfig(db, env);
  const trackUrl = `${cfg.resolvedAppUrl}/?view=track&order=${encodeURIComponent(params.orderNumber)}`;
  const adminUrl = `${cfg.resolvedAppUrl}/?view=admin&tab=orders&order=${encodeURIComponent(params.orderNumber)}`;
  const suffix = params.uniqueSuffix ? `:${params.uniqueSuffix}` : '';

  if (cfg.customerEvents[params.eventKey] !== false) {
    const custHtml = renderSelloraEmailHtml({
      title: params.customerTitle,
      greeting: `Hello ${params.customerName},`,
      intro: params.customerIntro,
      orderNumber: params.orderNumber,
      statusLabel: params.statusLabel,
      detailsRows: [
        { label: 'Order Total', value: params.totalFormatted },
        ...(params.deliveryLocation ? [{ label: 'Delivery Location', value: params.deliveryLocation }] : []),
        ...(params.extraRows || []),
      ],
      ctaLabel: 'Track Your Order',
      ctaUrl: trackUrl,
    });
    const res = await queueEmailEvent(db, {
      idempotencyKey: `cust:${params.eventKey}:${params.orderId}:${params.statusLabel}${suffix}`,
      orderId: params.orderId,
      orderNumber: params.orderNumber,
      recipientEmail: params.customerEmail,
      recipientType: 'customer',
      notificationType: params.eventKey,
      subject: `[SELLORA] ${params.customerTitle} — ${params.orderNumber}`,
      htmlBody: custHtml,
    });
    if (res.queued && res.eventId) {
      await dispatchSingleEmailEvent(db, env, res.eventId);
    }
  }

  if (cfg.adminNotificationEmail && cfg.adminEvents[params.eventKey] !== false) {
    const adminHtml = renderSelloraEmailHtml({
      title: params.adminTitle,
      greeting: 'Store Administration Notice,',
      intro: params.adminIntro,
      orderNumber: params.orderNumber,
      statusLabel: params.statusLabel,
      detailsRows: [
        { label: 'Internal Order ID', value: params.orderId },
        { label: 'Customer', value: `${params.customerName} (${params.customerEmail})` },
        { label: 'Order Total', value: params.totalFormatted },
        ...(params.deliveryLocation ? [{ label: 'Delivery Location', value: params.deliveryLocation }] : []),
        ...(params.extraRows || []),
      ],
      ctaLabel: 'Open Order in Admin',
      ctaUrl: adminUrl,
      footerNote: 'Automated administrative notification from SELLORA.',
    });
    const res = await queueEmailEvent(db, {
      idempotencyKey: `adm:${params.eventKey}:${params.orderId}:${params.statusLabel}${suffix}`,
      orderId: params.orderId,
      orderNumber: params.orderNumber,
      recipientEmail: cfg.adminNotificationEmail,
      recipientType: 'admin',
      notificationType: params.eventKey,
      subject: `[SELLORA Admin] ${params.adminTitle} — ${params.orderNumber}`,
      htmlBody: adminHtml,
    });
    if (res.queued && res.eventId) {
      await dispatchSingleEmailEvent(db, env, res.eventId);
    }
  }
}

export async function notifyCustomerWelcomeEmail(
  db: SelloraDb,
  env: EmailEnvConfig,
  user: { id: string; name?: string | null; email: string }
): Promise<void> {
  const cfg = await getEffectiveEmailConfig(db, env);
  if (cfg.customerEvents.welcome === false) return;
  const html = renderSelloraEmailHtml({
    title: 'Welcome to SELLORA',
    greeting: `Hello ${user.name || 'Customer'},`,
    intro:
      'Your SELLORA customer account is ready. You can now manage Nigerian delivery addresses, track orders, save items to your wishlist, and upload bank transfer receipts securely.',
    ctaLabel: 'Visit Your Account',
    ctaUrl: `${cfg.resolvedAppUrl}/?view=account`,
  });
  const queued = await queueEmailEvent(db, {
    idempotencyKey: `welcome:${user.id}`,
    recipientEmail: user.email,
    recipientType: 'customer',
    notificationType: 'welcome',
    subject: '[SELLORA] Welcome — Your Account Is Ready',
    htmlBody: html,
  });
  if (queued.queued && queued.eventId) {
    await dispatchSingleEmailEvent(db, env, queued.eventId);
  }
}
