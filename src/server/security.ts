import { randomUuid, sha256Hex } from './crypto';
import type { SelloraDb } from './db';

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const usedTurnstileTokens = new Map<string, number>();
const TURNSTILE_REPLAY_TTL_MS = 10 * 60_000;

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  const existing = rateBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
  if (existing.count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - existing.count),
    retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

export function isTurnstileConfigured(env: {
  turnstileSecretKey?: string;
  turnstileSiteKey?: string;
}): boolean {
  return Boolean(env.turnstileSecretKey?.trim() && env.turnstileSiteKey?.trim());
}

export async function verifyTurnstileToken(params: {
  token?: string;
  secretKey?: string;
  siteKey?: string;
  remoteIp?: string;
}): Promise<{ ok: boolean; status: 'verified' | 'disabled' | 'failed'; error?: string }> {
  const secretKey = params.secretKey?.trim() || '';
  const siteKey = params.siteKey?.trim() || '';

  if (!secretKey || !siteKey) {
    // Either key is absent: Turnstile is disabled rather than pretending verification passed
    return { ok: true, status: 'disabled' };
  }

  if (!params.token || params.token.trim() === '') {
    return {
      ok: false,
      status: 'failed',
      error: 'Please complete the security verification check.',
    };
  }

  const trimmed = params.token.trim();
  const now = Date.now();
  for (const [k, exp] of usedTurnstileTokens.entries()) {
    if (exp <= now) usedTurnstileTokens.delete(k);
  }
  const digest = await sha256Hex(trimmed);
  if (usedTurnstileTokens.has(digest)) {
    return {
      ok: false,
      status: 'failed',
      error: 'Security verification token was already used or expired. Please complete the check again.',
    };
  }

  try {
    const form = new URLSearchParams();
    form.set('secret', secretKey);
    form.set('response', trimmed);
    if (params.remoteIp) form.set('remoteip', params.remoteIp);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (!data.success) {
      return {
        ok: false,
        status: 'failed',
        error: 'Bot verification failed. Please retry the security check.',
      };
    }
    usedTurnstileTokens.set(digest, now + TURNSTILE_REPLAY_TTL_MS);
    return { ok: true, status: 'verified' };
  } catch {
    return {
      ok: false,
      status: 'failed',
      error: 'Unable to reach Turnstile verification service.',
    };
  }
}

export async function writeAuditLog(
  db: SelloraDb,
  params: {
    actorId?: string | null;
    actorEmail?: string | null;
    actorRole?: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    details?: Record<string, unknown>;
    ipAddress?: string | null;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, actor_email, actor_role, action, target_type, target_id, details_json, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `aud_${randomUuid()}`,
      params.actorId ?? null,
      params.actorEmail ?? null,
      params.actorRole ?? null,
      params.action,
      params.targetType,
      params.targetId ?? null,
      JSON.stringify(params.details ?? {}),
      params.ipAddress ?? null,
      new Date().toISOString(),
    ]
  );
}
