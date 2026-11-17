import { Hono } from 'hono';
import { z } from 'zod';
import { sha256Hex } from '../crypto';
import type { AppContext } from '../context';
import { checkPersistentRateLimit, getTrustedClientIp, writeAuditLog } from '../security';
import { sanitizeDiagnosticObject } from '../error-monitor';

interface DeveloperIntegrationAuth {
  integrationId: string;
  portalName: string;
  scopes: string[];
}

type DeveloperContext = {
  Variables: AppContext['Variables'] & {
    developerActor: DeveloperIntegrationAuth;
  };
};

/**
 * Layer 3: Isolated Client-Authorized Developer Portal Endpoints.
 * Strictly authenticated ONLY via revocable, expiring Bearer integration keys
 * authorized by the SELLORA store owner (`developer_integrations`).
 * Deliberately rejects store cookies and cannot read/modify customer orders,
 * bank details, products, or store ownership.
 */
export function createDeveloperRoutes() {
  const app = new Hono<DeveloperContext>();

  app.use('*', async (c, next) => {
    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `devapi:${ip}`, 60, 60_000);
    if (!rl.allowed) {
      return c.json({ error: 'Developer API rate limit exceeded.' }, 429);
    }

    const authHeader = c.req.header('authorization') || '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return c.json(
        { error: 'Developer integration Bearer key required. Store session cookies are rejected.' },
        401
      );
    }

    const rawKey = authHeader.slice(7).trim();
    if (!rawKey.startsWith('slr_dev_') || rawKey.length < 24) {
      return c.json({ error: 'Invalid developer integration key.' }, 401);
    }

    const hash = await sha256Hex(rawKey);
    const now = new Date().toISOString();
    const row = await db.get<{
      id: string;
      portal_name: string;
      scopes_json: string;
      is_active: number;
      expires_at: string | null;
    }>(
      `SELECT id, portal_name, scopes_json, is_active, expires_at
       FROM developer_integrations WHERE api_key_hash = ?`,
      [hash]
    );

    if (!row || row.is_active !== 1 || (row.expires_at && row.expires_at < now)) {
      return c.json({ error: 'Developer integration key is inactive, revoked, or expired.' }, 403);
    }

    let scopes: string[] = [];
    try {
      const parsed = JSON.parse(row.scopes_json || '[]');
      if (Array.isArray(parsed)) scopes = parsed.map(String);
    } catch {
      scopes = [];
    }

    await db
      .run(`UPDATE developer_integrations SET last_used_at = ? WHERE id = ?`, [now, row.id])
      .catch(() => {});

    c.set('developerActor', {
      integrationId: row.id,
      portalName: row.portal_name,
      scopes,
    });

    return next();
  });

  const requireScope = (scope: string) => {
    return async (c: any, next: any) => {
      const dev = c.get('developerActor') as DeveloperIntegrationAuth | undefined;
      if (!dev || !dev.scopes.includes(scope)) {
        return c.json({ error: `Missing developer scope: ${scope}` }, 403);
      }
      return next();
    };
  };

  // Query sanitized error logs (newest first, filterable by status/category/refId)
  app.get('/errors', requireScope('errors:read'), async (c) => {
    const db = c.get('db');
    const status = c.req.query('status');
    const category = c.req.query('category');
    const refId = c.req.query('refId');

    let sql = `SELECT id, ref_id, service_category, error_category, failed_operation, location,
                      environment, correlation_id, sanitized_message, source_location, provider_error_code,
                      retry_history_json, occurrence_count, investigation_status, resolution_notes,
                      resolved_by, resolved_at, created_at, updated_at
               FROM error_monitoring_logs WHERE 1=1`;
    const params: unknown[] = [];

    if (status) {
      sql += ` AND investigation_status = ?`;
      params.push(status);
    }
    if (category) {
      sql += ` AND service_category = ?`;
      params.push(category);
    }
    if (refId) {
      sql += ` AND UPPER(ref_id) = UPPER(?)`;
      params.push(refId.trim());
    }

    sql += ` ORDER BY updated_at DESC LIMIT 100`;
    const rows = await db.all(sql, params);
    return c.json({ errors: rows });
  });

  app.get('/errors/:refId', requireScope('errors:read'), async (c) => {
    const db = c.get('db');
    const refId = c.req.param('refId').trim().toUpperCase();
    const row = await db.get(
      `SELECT id, ref_id, service_category, error_category, failed_operation, location,
              environment, correlation_id, sanitized_message, source_location, provider_error_code,
              retry_history_json, occurrence_count, investigation_status, resolution_notes,
              resolved_by, resolved_at, created_at, updated_at
       FROM error_monitoring_logs WHERE UPPER(ref_id) = ?`,
      [refId]
    );
    if (!row) return c.json({ error: 'Error reference not found' }, 404);
    return c.json({ errorRecord: row });
  });

  app.patch('/errors/:refId', requireScope('errors:update'), async (c) => {
    const db = c.get('db');
    const dev = c.get('developerActor');
    const refId = c.req.param('refId').trim().toUpperCase();
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      investigationStatus: z.enum(['open', 'investigating', 'resolved', 'ignored']),
      resolutionNotes: z.string().max(1500).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid error status update payload' }, 400);
    }

    const now = new Date().toISOString();
    const resolvedAt =
      parsed.data.investigationStatus === 'resolved' || parsed.data.investigationStatus === 'ignored'
        ? now
        : null;

    const res = await db.run(
      `UPDATE error_monitoring_logs
       SET investigation_status = ?,
           resolution_notes = COALESCE(?, resolution_notes),
           resolved_by = ?,
           resolved_at = COALESCE(?, resolved_at),
           updated_at = ?
       WHERE UPPER(ref_id) = ?`,
      [
        parsed.data.investigationStatus,
        parsed.data.resolutionNotes ?? null,
        dev.portalName,
        resolvedAt,
        now,
        refId,
      ]
    );
    if (res.changes === 0) return c.json({ error: 'Error reference not found' }, 404);

    await writeAuditLog(db, {
      actorId: dev.integrationId,
      actorEmail: `portal:${dev.portalName}`,
      actorRole: 'developer_integration',
      action: 'DEVELOPER_ERROR_STATUS_UPDATED',
      targetType: 'error_monitoring_log',
      targetId: refId,
      details: { status: parsed.data.investigationStatus },
    });

    return c.json({ ok: true });
  });

  app.get('/security-events', requireScope('security:read'), async (c) => {
    const db = c.get('db');
    const status = c.req.query('status');
    let sql = `SELECT id, event_ref, event_category, severity, risk_level, status,
                      approx_location, device_summary, metadata_json, investigated_by,
                      resolution_notes, created_at, resolved_at
               FROM security_events WHERE 1=1`;
    const params: unknown[] = [];
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY created_at DESC LIMIT 100`;
    const events = await db.all(sql, params);
    return c.json({ events });
  });

  app.patch('/security-events/:eventRef', requireScope('security:update'), async (c) => {
    const db = c.get('db');
    const dev = c.get('developerActor');
    const eventRef = c.req.param('eventRef').trim().toUpperCase();
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      status: z.enum(['recorded', 'mitigated', 'resolved']),
      resolutionNotes: z.string().max(1500).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid security event update payload' }, 400);

    const now = new Date().toISOString();
    const res = await db.run(
      `UPDATE security_events
       SET status = ?,
           investigated_by = ?,
           resolution_notes = COALESCE(?, resolution_notes),
           resolved_at = ?
       WHERE UPPER(event_ref) = ?`,
      [
        parsed.data.status,
        dev.portalName,
        parsed.data.resolutionNotes ?? null,
        parsed.data.status === 'resolved' || parsed.data.status === 'mitigated' ? now : null,
        eventRef,
      ]
    );
    if (res.changes === 0) return c.json({ error: 'Security event not found' }, 404);

    await writeAuditLog(db, {
      actorId: dev.integrationId,
      actorEmail: `portal:${dev.portalName}`,
      actorRole: 'developer_integration',
      action: 'DEVELOPER_SECURITY_EVENT_UPDATED',
      targetType: 'security_event',
      targetId: eventRef,
      details: { status: parsed.data.status },
    });

    return c.json({ ok: true });
  });

  app.get('/audit-logs', requireScope('audit:read'), async (c) => {
    const db = c.get('db');
    const logs = await db.all<{
      id: string;
      actor_role: string | null;
      action: string;
      target_type: string;
      target_id: string | null;
      details_json: string;
      created_at: string;
    }>(
      `SELECT id, actor_role, action, target_type, target_id, details_json, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT 100`
    );
    return c.json({
      logs: logs.map((l) => ({
        ...l,
        details: sanitizeDiagnosticObject(
          (() => {
            try {
              return JSON.parse(l.details_json || '{}');
            } catch {
              return {};
            }
          })()
        ),
      })),
    });
  });

  return app;
}
