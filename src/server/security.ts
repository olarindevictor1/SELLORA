import { generateReferenceId, randomUuid, sha256Hex } from './crypto';
import type { SelloraDb } from './db';

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const usedTurnstileTokens = new Map<string, number>();
const TURNSTILE_REPLAY_TTL_MS = 10 * 60_000;

/**
 * Extracts a trusted client IP according to deployment runtime.
 * On Cloudflare Workers, `cf-connecting-ip` is injected at the edge and cannot be spoofed
 * by clients, whereas `x-forwarded-for` CAN be spoofed and is ignored.
 */
export function getTrustedClientIp(
  headers: Headers,
  env?: { runtime?: 'worker' | 'node'; trustedProxy?: boolean }
): string {
  const cfIp = headers.get('cf-connecting-ip')?.trim();
  if (env?.runtime === 'worker') {
    return cfIp || headers.get('true-client-ip')?.trim() || 'worker-client';
  }
  if (cfIp) return cfIp;
  if (env?.trustedProxy) {
    const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (xff) return xff;
    const xReal = headers.get('x-real-ip')?.trim();
    if (xReal) return xReal;
  }
  return 'local';
}

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

/**
 * Persistent shared rate limiter backed by D1 / SQLite (`security_rate_limits`),
 * surviving Worker isolate restarts and enforcing consistent limits across requests.
 */
export async function checkPersistentRateLimit(
  db: SelloraDb,
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }> {
  const now = Date.now();
  const nextReset = now + windowMs;
  const nowIso = new Date(now).toISOString();

  try {
    await db.run(
      `INSERT INTO security_rate_limits (bucket_key, count, reset_at_ms, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = CASE
           WHEN security_rate_limits.reset_at_ms <= ? THEN 1
           ELSE security_rate_limits.count + 1
         END,
         reset_at_ms = CASE
           WHEN security_rate_limits.reset_at_ms <= ? THEN excluded.reset_at_ms
           ELSE security_rate_limits.reset_at_ms
         END,
         updated_at = excluded.updated_at`,
      [key, nextReset, nowIso, now, now]
    );

    const row = await db.get<{ count: number; reset_at_ms: number }>(
      `SELECT count, reset_at_ms FROM security_rate_limits WHERE bucket_key = ?`,
      [key]
    );
    const count = Number(row?.count ?? 1);
    const resetAt = Number(row?.reset_at_ms ?? nextReset);
    const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000));

    if (count > maxRequests) {
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - count),
      retryAfterSec,
    };
  } catch {
    // Degrade gracefully to isolate limiter if rate limit table is unreachable
    return checkRateLimit(key, maxRequests, windowMs);
  }
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
  db?: SelloraDb;
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
  const digest = await sha256Hex(trimmed);

  // Check persistent replay store if db available, plus isolate fallback map
  if (params.db) {
    try {
      const used = await params.db.get<{ expires_at_ms: number }>(
        `SELECT expires_at_ms FROM security_used_tokens WHERE token_hash = ? AND expires_at_ms > ?`,
        [digest, now]
      );
      if (used) {
        return {
          ok: false,
          status: 'failed',
          error: 'Security verification token was already used or expired. Please complete the check again.',
        };
      }
    } catch {
      // ignore read failure and check memory map
    }
  }

  for (const [k, exp] of usedTurnstileTokens.entries()) {
    if (exp <= now) usedTurnstileTokens.delete(k);
  }
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

    const expMs = now + TURNSTILE_REPLAY_TTL_MS;
    usedTurnstileTokens.set(digest, expMs);
    if (params.db) {
      await params.db
        .run(
          `INSERT INTO security_used_tokens (token_hash, purpose, expires_at_ms, created_at)
           VALUES (?, 'turnstile', ?, ?)
           ON CONFLICT(token_hash) DO UPDATE SET expires_at_ms = excluded.expires_at_ms`,
          [digest, expMs, new Date(now).toISOString()]
        )
        .catch(() => {});
    }

    return { ok: true, status: 'verified' };
  } catch {
    return {
      ok: false,
      status: 'failed',
      error: 'Unable to complete security verification right now.',
    };
  }
}

export const DEFAULT_MAX_LOGIN_LOCKOUT_SECONDS = 3600; // 60 minutes

export function resolveMaxLockoutSeconds(raw?: string | number | null): number {
  const num = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MAX_LOGIN_LOCKOUT_SECONDS;
  // Minimum 10 minutes (600s), maximum 24 hours (86400s)
  return Math.max(600, Math.min(86_400, Math.floor(num)));
}

const signInEmailLocks = new Map<string, Promise<void>>();

/**
 * Serializes concurrent password sign-in attempts targeting the same email within an isolate
 * so parallel bursts cannot execute password checks simultaneously to bypass attempt limits.
 */
export async function withSignInEmailLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const key = email.trim().toLowerCase();
  const prev = signInEmailLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.catch(() => {}).then(() => gate);
  signInEmailLocks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (signInEmailLocks.get(key) === chained) {
      signInEmailLocks.delete(key);
    }
  }
}

/**
 * Progressive brute-force login throttle enforcing:
 * - Attempt 1: recorded, no lockout
 * - Attempt 2: 10-minute (600s) lockout
 * - Attempt 3+ after lockout expires: +5 minutes (300s) per completed cycle (15m, 20m, 25m...)
 * - Bounded by configurable maxLockoutSec (default 3600s = 60 minutes) to prevent permanent DoS
 * - Paired with IP-level throttling against multi-account stuffing
 */
export async function checkLoginThrottle(
  db: SelloraDb,
  email: string,
  ip: string,
  opts?: { nowMs?: number }
): Promise<{
  allowed: boolean;
  retryAfterSec: number;
  reason?: string;
  unavailable?: boolean;
  error?: unknown;
}> {
  const normEmail = email.trim().toLowerCase();
  const acctKey = `acct:${normEmail}`;
  const ipKey = `ip:${ip}`;
  const now = opts?.nowMs ?? Date.now();

  try {
    // Include lockout_cycles in the initial read so an unapplied 0006 migration fails closed immediately
    const rows = await db.all<{
      throttle_key: string;
      locked_until_ms: number;
      lockout_cycles: number;
    }>(
      `SELECT throttle_key, locked_until_ms, lockout_cycles FROM auth_login_throttles
       WHERE throttle_key IN (?, ?)`,
      [acctKey, ipKey]
    );

    let maxLockedUntil = 0;
    for (const r of rows) {
      const until = Number(r.locked_until_ms || 0);
      if (until > now) {
        maxLockedUntil = Math.max(maxLockedUntil, until);
      }
    }
    if (maxLockedUntil > now) {
      const retryAfterSec = Math.max(1, Math.ceil((maxLockedUntil - now) / 1000));
      return {
        allowed: false,
        retryAfterSec,
        // Generic copy — never leaks whether account exists or exposes lockout rules/counters
        reason:
          'Sign-in is temporarily restricted due to repeated attempts. Please wait before trying again or reset your password.',
      };
    }
    return { allowed: true, retryAfterSec: 0 };
  } catch (err) {
    return {
      allowed: false,
      unavailable: true,
      retryAfterSec: 0,
      reason: 'Sign-in protection is temporarily unavailable. Please try again shortly.',
      error: err,
    };
  }
}

export async function recordFailedLoginAttempt(
  db: SelloraDb,
  email: string,
  ip: string,
  opts?: { maxLockoutSec?: number; nowMs?: number }
): Promise<{
  locked: boolean;
  newlyLocked: boolean;
  retryAfterSec: number;
  failCount: number;
  lockoutCycles: number;
  escalatedEvent: boolean;
  unavailable?: boolean;
  error?: unknown;
}> {
  const normEmail = email.trim().toLowerCase();
  const acctKey = `acct:${normEmail}`;
  const ipKey = `ip:${ip}`;
  const now = opts?.nowMs ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const maxLockoutSec = resolveMaxLockoutSeconds(opts?.maxLockoutSec);
  const maxLockoutMs = maxLockoutSec * 1000;
  const ipWindowCutoffIso = new Date(now - 15 * 60_000).toISOString();

  try {
    const prevAcct = await db.get<{ lockout_cycles: number; locked_until_ms: number }>(
      `SELECT lockout_cycles, locked_until_ms FROM auth_login_throttles WHERE throttle_key = ?`,
      [acctKey]
    );
    const prevCycles = Number(prevAcct?.lockout_cycles ?? 0);

    // Atomic single-statement state transition on acct:${normEmail}:
    // Never extends/accelerates lockout if already actively locked; otherwise increments fail_count,
    // and on fail_count >= 2 computes 10m + (completedCycles * 5m), capped at maxLockoutMs.
    await db.run(
      `INSERT INTO auth_login_throttles (
         throttle_key, email, ip_address, fail_count, locked_until_ms, lockout_cycles, first_failed_at, last_failed_at
       ) VALUES (?, ?, ?, 1, 0, 0, ?, ?)
       ON CONFLICT(throttle_key) DO UPDATE SET
         ip_address = excluded.ip_address,
         fail_count = CASE
           WHEN auth_login_throttles.locked_until_ms > ? THEN auth_login_throttles.fail_count
           ELSE auth_login_throttles.fail_count + 1
         END,
         lockout_cycles = CASE
           WHEN auth_login_throttles.locked_until_ms > ? THEN auth_login_throttles.lockout_cycles
           WHEN auth_login_throttles.fail_count + 1 >= 2 THEN auth_login_throttles.lockout_cycles + 1
           ELSE 0
         END,
         locked_until_ms = CASE
           WHEN auth_login_throttles.locked_until_ms > ? THEN auth_login_throttles.locked_until_ms
           WHEN auth_login_throttles.fail_count + 1 >= 2 THEN ? + MIN(?, (600 + auth_login_throttles.lockout_cycles * 300) * 1000)
           ELSE 0
         END,
         last_failed_at = excluded.last_failed_at`,
      [acctKey, normEmail, ip, nowIso, nowIso, now, now, now, now, maxLockoutMs]
    );

    // Atomic IP-based throttling (20 failures from one IP in 15 min -> 5-minute IP cooldown)
    await db.run(
      `INSERT INTO auth_login_throttles (
         throttle_key, email, ip_address, fail_count, locked_until_ms, lockout_cycles, first_failed_at, last_failed_at
       ) VALUES (?, NULL, ?, 1, 0, 0, ?, ?)
       ON CONFLICT(throttle_key) DO UPDATE SET
         fail_count = CASE
           WHEN auth_login_throttles.locked_until_ms > ? THEN auth_login_throttles.fail_count
           WHEN auth_login_throttles.last_failed_at < ? THEN 1
           ELSE auth_login_throttles.fail_count + 1
         END,
         locked_until_ms = CASE
           WHEN auth_login_throttles.locked_until_ms > ? THEN auth_login_throttles.locked_until_ms
           WHEN auth_login_throttles.last_failed_at >= ? AND auth_login_throttles.fail_count + 1 >= 20 THEN ? + 300000
           ELSE 0
         END,
         last_failed_at = excluded.last_failed_at`,
      [ipKey, ip, nowIso, nowIso, now, ipWindowCutoffIso, now, ipWindowCutoffIso, now]
    );

    const acctRow = await db.get<{
      fail_count: number;
      locked_until_ms: number;
      lockout_cycles: number;
    }>(
      `SELECT fail_count, locked_until_ms, lockout_cycles FROM auth_login_throttles WHERE throttle_key = ?`,
      [acctKey]
    );
    const ipRow = await db.get<{ fail_count: number; locked_until_ms: number }>(
      `SELECT fail_count, locked_until_ms FROM auth_login_throttles WHERE throttle_key = ?`,
      [ipKey]
    );

    const acctLockedUntil = Number(acctRow?.locked_until_ms ?? 0);
    const ipLockedUntil = Number(ipRow?.locked_until_ms ?? 0);
    const maxLockedUntil = Math.max(acctLockedUntil, ipLockedUntil);
    const locked = maxLockedUntil > now;
    const retryAfterSec = locked ? Math.max(1, Math.ceil((maxLockedUntil - now) / 1000)) : 0;
    const failCount = Number(acctRow?.fail_count ?? 1);
    const lockoutCycles = Number(acctRow?.lockout_cycles ?? 0);
    const newlyLocked = lockoutCycles > prevCycles && acctLockedUntil > now;
    const ipEscalated = Number(ipRow?.fail_count ?? 0) === 20;
    const escalated = newlyLocked || ipEscalated;

    if (escalated) {
      await recordSecurityEvent(db, {
        email: normEmail,
        eventCategory: ipEscalated ? 'ip_brute_force_throttled' : 'account_lockout_triggered',
        severity: lockoutCycles >= 2 || ipEscalated ? 'high' : 'medium',
        riskLevel: lockoutCycles >= 2 || ipEscalated ? 'high' : 'medium',
        ipAddress: ip,
        metadata: {
          consecutiveFailures: failCount,
          lockoutCycles,
          lockSeconds: retryAfterSec,
          ipFailCount: Number(ipRow?.fail_count ?? 0),
        },
      });
    }

    return {
      locked,
      newlyLocked,
      retryAfterSec,
      failCount,
      lockoutCycles,
      escalatedEvent: escalated,
    };
  } catch (err) {
    return {
      locked: true,
      newlyLocked: false,
      retryAfterSec: 0,
      failCount: 0,
      lockoutCycles: 0,
      escalatedEvent: false,
      unavailable: true,
      error: err,
    };
  }
}

export async function clearLoginThrottle(db: SelloraDb, email: string, ip: string): Promise<void> {
  const normEmail = email.trim().toLowerCase();
  const acctKey = `acct:${normEmail}`;
  const legacyPairKey = `pair:${normEmail}:${ip}`;
  await db
    .run(`DELETE FROM auth_login_throttles WHERE throttle_key IN (?, ?)`, [acctKey, legacyPairKey])
    .catch(() => {});
}

/**
 * Magic-byte inspection + polyglot HTML/SVG script scan for uploaded receipts & product media.
 */
export function validateUploadedFileBytes(
  bytes: Uint8Array,
  declaredMime: string,
  allowedMimes: string[]
): { ok: true; detectedMime: string; extension: string } | { ok: false; error: string } {
  if (!allowedMimes.includes(declaredMime)) {
    return { ok: false, error: 'Unsupported file type.' };
  }
  if (bytes.length < 12) {
    return { ok: false, error: 'Uploaded file is empty or corrupted.' };
  }

  // Reject SVG / HTML / script payloads regardless of extension or MIME header
  const headText = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
    .trimStart()
    .toLowerCase();
  if (
    headText.startsWith('<svg') ||
    headText.startsWith('<?xml') ||
    headText.startsWith('<!doctype html') ||
    headText.startsWith('<html') ||
    headText.includes('<script')
  ) {
    return { ok: false, error: 'Active script or markup payloads are rejected for security.' };
  }

  const startsWith = (sig: number[]) =>
    sig.length <= bytes.length && sig.every((b, idx) => bytes[idx] === b);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (declaredMime === 'image/png') {
    if (!startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return { ok: false, error: 'File content does not match PNG image signature.' };
    }
    return { ok: true, detectedMime: 'image/png', extension: 'png' };
  }

  // JPEG: FF D8 FF
  if (declaredMime === 'image/jpeg') {
    if (!startsWith([0xff, 0xd8, 0xff])) {
      return { ok: false, error: 'File content does not match JPEG image signature.' };
    }
    return { ok: true, detectedMime: 'image/jpeg', extension: 'jpeg' };
  }

  // WEBP: RIFF....WEBP
  if (declaredMime === 'image/webp') {
    const isRiff = startsWith([0x52, 0x49, 0x46, 0x46]);
    const isWebp =
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    if (!isRiff || !isWebp) {
      return { ok: false, error: 'File content does not match WEBP image signature.' };
    }
    return { ok: true, detectedMime: 'image/webp', extension: 'webp' };
  }

  // PDF: %PDF-
  if (declaredMime === 'application/pdf') {
    if (!startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) {
      return { ok: false, error: 'File content does not match PDF document signature.' };
    }
    return { ok: true, detectedMime: 'application/pdf', extension: 'pdf' };
  }

  // MP4: ....ftyp
  if (declaredMime === 'video/mp4') {
    const hasFtyp =
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    if (!hasFtyp) {
      return { ok: false, error: 'File content does not match MP4 video signature.' };
    }
    return { ok: true, detectedMime: 'video/mp4', extension: 'mp4' };
  }

  return { ok: false, error: 'Unsupported file format.' };
}

export function sanitizeUploadFilename(rawName: string, fallback = 'upload'): string {
  const base = (rawName || fallback)
    .replace(/[/\\]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  return (base || fallback).slice(0, 120);
}

/**
 * Extracts session token from Cookie header without relying solely on Better Auth internals,
 * and validates that the session was created recently for step-up sensitive operations.
 */
export function extractSessionTokenFromHeaders(headers: Headers): string | null {
  const cookieHeader = headers.get('cookie') || '';
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === 'sellora.session_token' || key === '__Secure-sellora.session_token') {
      const rawVal = decodeURIComponent(part.slice(idx + 1).trim());
      // Better Auth signed cookies look like "<token>.<hmac>"; DB stores "<token>"
      return rawVal.split('.')[0] || null;
    }
  }
  return null;
}

export async function requireRecentAuthSession(
  db: SelloraDb,
  headers: Headers,
  maxAgeMs = 30 * 60_000
): Promise<boolean> {
  const token = extractSessionTokenFromHeaders(headers);
  if (!token) return false;
  const row = await db.get<{ createdAt: string; updatedAt: string }>(
    `SELECT createdAt, updatedAt FROM session WHERE token = ?`,
    [token]
  );
  if (!row) return false;
  const ts = Date.parse(row.createdAt || row.updatedAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= maxAgeMs;
}

export async function recordSecurityEvent(
  db: SelloraDb,
  params: {
    userId?: string | null;
    email?: string | null;
    eventCategory: string;
    severity?: 'low' | 'medium' | 'high' | 'critical';
    riskLevel?: 'low' | 'medium' | 'high';
    status?: 'recorded' | 'confirmed_by_user' | 'disputed_by_user' | 'mitigated' | 'resolved';
    ipAddress?: string | null;
    approxLocation?: string | null;
    deviceSummary?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const eventRef = generateReferenceId('SEC', 8);
  const now = new Date().toISOString();
  await db
    .run(
      `INSERT INTO security_events (
        id, event_ref, user_id, email, event_category, severity, ip_address, approx_location,
        device_summary, user_agent, risk_level, status, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `sec_${randomUuid()}`,
        eventRef,
        params.userId ?? null,
        params.email ?? null,
        params.eventCategory,
        params.severity ?? 'medium',
        params.ipAddress ?? null,
        params.approxLocation ?? null,
        params.deviceSummary ?? null,
        params.userAgent ? params.userAgent.slice(0, 280) : null,
        params.riskLevel ?? 'medium',
        params.status ?? 'recorded',
        JSON.stringify(params.metadata ?? {}),
        now,
      ]
    )
    .catch(() => {});
  return eventRef;
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
