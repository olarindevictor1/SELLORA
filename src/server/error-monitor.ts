import type { Context } from 'hono';
import { generateReferenceId, randomUuid } from './crypto';
import type { AppContext } from './context';
import type { SelloraDb } from './db';

export type ErrorServiceCategory =
  | 'api'
  | 'auth'
  | 'database'
  | 'checkout'
  | 'payment'
  | 'email'
  | 'storage'
  | 'security'
  | 'webhook'
  | 'validation';

export interface CaptureErrorInput {
  serviceCategory?: ErrorServiceCategory;
  errorCategory?: string;
  failedOperation: string;
  location: string;
  environment?: string;
  correlationId?: string | null;
  error: unknown;
  sourceLocation?: string | null;
  providerErrorCode?: string | null;
  retryAttempt?: number;
  extraSafeContext?: Record<string, unknown>;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]'],
  [/\b(slr_dev_[A-Za-z0-9_-]+)\b/gi, '[REDACTED_DEV_TOKEN]'],
  [/\b(xkeysib-[A-Za-z0-9-]+)\b/gi, '[REDACTED_MAIL_KEY]'],
  [/\b(AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED_API_KEY]'],
  [/\b(GOCSPX-[0-9A-Za-z_-]+)\b/g, '[REDACTED_OAUTH_SECRET]'],
  [/(["']?(?:password|secret|token|cookie|authorization|api[_-]?key|set-cookie|clientSecret|betterAuthSecret|brevoApiKey|turnstileSecretKey)["']?\s*[:=]\s*)(["']?)[^"',\s}\n]+\2/gi, '$1[REDACTED]'],
  [/\b(?:sqlite|postgres|mysql|d1):\/\/[^\s]+/gi, '[REDACTED_DB_URI]'],
];

/**
 * Strips secrets, credentials, session cookies, tokens, and SQL/provider sensitive strings
 * from diagnostic strings before storage or fallback logging.
 */
export function redactSensitiveText(raw: string, maxLen = 900): string {
  let clean = raw || 'Unexpected error';
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }
  // Remove multi-line local filesystem stack paths if unnecessarily verbose while preserving module hint
  clean = clean.replace(/\/app\/applet\//g, '').replace(/[A-Za-z]:\\[^\s:]+/g, '[path]');
  return clean.slice(0, maxLen);
}

export function sanitizeDiagnosticObject(obj: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactSensitiveText(obj, 400);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 10).map((item) => sanitizeDiagnosticObject(item, depth + 1));
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (/pass(word)?|secret|token|cookie|authorization|api[_-]?key|session|hash/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeDiagnosticObject(v, depth + 1);
      }
    }
    return out;
  }
  return String(obj);
}

function extractSafeErrorSummary(err: unknown): {
  category: string;
  message: string;
  sourceLocation: string | null;
} {
  if (err instanceof Error) {
    const firstFrame = err.stack
      ?.split('\n')
      .slice(1)
      .find((line) => line.includes('src/') || line.includes('worker/') || line.includes('server.ts'));
    const sourceLocation = firstFrame ? redactSensitiveText(firstFrame.trim(), 200) : null;
    return {
      category: err.name || 'Error',
      message: redactSensitiveText(err.message || err.name),
      sourceLocation,
    };
  }
  return {
    category: 'UnknownError',
    message: redactSensitiveText(typeof err === 'string' ? err : JSON.stringify(err ?? 'Unknown error')),
    sourceLocation: null,
  };
}

/**
 * Records a captured sanitized diagnostic error in error_monitoring_logs with an unpredictable ERR-XXXXXXXX ID.
 * Deduplicates identical recent errors within a 5-minute window to prevent database flooding.
 * If database persistence fails, degrades safely to a redacted structured fallback log without crashing the request.
 */
export async function recordCapturedError(
  db: SelloraDb | null | undefined,
  input: CaptureErrorInput,
  fallbackLogger?: (entry: Record<string, unknown>) => void
): Promise<{ refId: string; deduplicated: boolean; persistedToDb: boolean }> {
  const refId = generateReferenceId('ERR', 8);
  const summary = extractSafeErrorSummary(input.error);
  const errorCategory = input.errorCategory || summary.category;
  const serviceCategory = input.serviceCategory || 'api';
  const now = new Date().toISOString();
  const environment = input.environment || 'production';
  const sanitizedMessage = input.extraSafeContext
    ? redactSensitiveText(
        `${summary.message} | context=${JSON.stringify(sanitizeDiagnosticObject(input.extraSafeContext))}`
      )
    : summary.message;

  const fallbackEntry = {
    level: 'error',
    refId,
    serviceCategory,
    errorCategory,
    failedOperation: input.failedOperation,
    location: input.location,
    environment,
    correlationId: input.correlationId ?? null,
    sanitizedMessage,
    timestamp: now,
  };

  if (!db) {
    if (fallbackLogger) fallbackLogger(fallbackEntry);
    else console.error('[SELLORA ERROR MONITOR]', JSON.stringify(fallbackEntry));
    return { refId, deduplicated: false, persistedToDb: false };
  }

  try {
    const windowStart = new Date(Date.now() - 5 * 60_000).toISOString();
    const existing = await db.get<{
      id: string;
      ref_id: string;
      retry_history_json: string;
      occurrence_count: number;
    }>(
      `SELECT id, ref_id, retry_history_json, occurrence_count
       FROM error_monitoring_logs
       WHERE location = ? AND error_category = ? AND sanitized_message = ? AND investigation_status != 'resolved' AND updated_at >= ?
       ORDER BY updated_at DESC LIMIT 1`,
      [input.location, errorCategory, sanitizedMessage, windowStart]
    );

    if (existing) {
      let retries: Array<Record<string, unknown>> = [];
      try {
        retries = JSON.parse(existing.retry_history_json || '[]');
      } catch {
        retries = [];
      }
      retries.push({
        at: now,
        refId,
        correlationId: input.correlationId ?? null,
        retryAttempt: input.retryAttempt ?? 0,
      });
      if (retries.length > 10) retries = retries.slice(-10);

      await db.run(
        `UPDATE error_monitoring_logs
         SET occurrence_count = occurrence_count + 1,
             retry_history_json = ?,
             updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(retries), now, existing.id]
      );
      return { refId: existing.ref_id, deduplicated: true, persistedToDb: true };
    }

    const retriesJson = JSON.stringify(
      input.retryAttempt !== undefined ? [{ at: now, refId, retryAttempt: input.retryAttempt }] : []
    );

    await db.run(
      `INSERT INTO error_monitoring_logs (
        id, ref_id, service_category, error_category, failed_operation, location,
        environment, correlation_id, sanitized_message, source_location, provider_error_code,
        retry_history_json, occurrence_count, investigation_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, ?)`,
      [
        `elog_${randomUuid()}`,
        refId,
        serviceCategory,
        errorCategory,
        input.failedOperation,
        input.location,
        environment,
        input.correlationId ?? null,
        sanitizedMessage,
        input.sourceLocation ?? summary.sourceLocation,
        input.providerErrorCode ? redactSensitiveText(input.providerErrorCode, 120) : null,
        retriesJson,
        now,
        now,
      ]
    );

    return { refId, deduplicated: false, persistedToDb: true };
  } catch {
    // Database write failed (e.g., DB outage): emit sanitized server log safely without crashing
    if (fallbackLogger) fallbackLogger(fallbackEntry);
    else console.error('[SELLORA ERROR FALLBACK]', JSON.stringify(fallbackEntry));
    return { refId, deduplicated: false, persistedToDb: false };
  }
}

export async function respondWithCapturedError(
  c: Context<AppContext>,
  opts: {
    status?: 400 | 500 | 502 | 503;
    publicMessage: string;
    serviceCategory?: ErrorServiceCategory;
    failedOperation: string;
    location: string;
    error: unknown;
    providerErrorCode?: string | null;
  }
): Promise<Response> {
  const db = c.get('db');
  const env = c.get('env');
  const correlationId = c.req.header('x-request-id') || c.req.header('cf-ray') || randomUuid();
  const captured = await recordCapturedError(
    db,
    {
      serviceCategory: opts.serviceCategory || 'api',
      failedOperation: opts.failedOperation,
      location: opts.location,
      environment: env?.environment || (env?.runtime === 'worker' ? 'production' : 'development'),
      correlationId,
      error: opts.error,
      providerErrorCode: opts.providerErrorCode ?? null,
    },
    env?.onFallbackLog
  );

  return c.json(
    {
      error: opts.publicMessage,
      referenceId: captured.refId,
    },
    opts.status ?? 500
  );
}
