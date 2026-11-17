import React, { useEffect, useState } from 'react';
import {
  Activity,
  Building2,
  KeyRound,
  Landmark,
  Mail,
  RefreshCw,
  Send,
  Shield,
  ShieldAlert,
} from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { formatLagosDate } from '../../shared/types';

type SettingsSection = 'profile' | 'staff' | 'payments' | 'security';

function sanitizeNotificationError(raw?: string | null): string {
  if (!raw) return '';
  if (/api[_ -]?key/i.test(raw) || /credentials are not configured/i.test(raw)) {
    return 'Notification service credentials are not configured.';
  }
  if (/from[_ -]?email|sender email/i.test(raw)) {
    return 'Verified sender email address is not configured.';
  }
  if (/brevo/i.test(raw)) {
    return 'Email delivery could not be completed by the mail service.';
  }
  return raw;
}

export const AdminSettingsTab: React.FC<{
  mode: 'email' | 'theme' | 'settings';
  capabilities: any;
  user?: any;
  onRefreshStorefront: () => Promise<void>;
}> = ({ mode, user, onRefreshStorefront }) => {
  const isOwner = user?.role === 'owner';
  const [section, setSection] = useState<SettingsSection>('profile');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Settings objects
  const [bank, setBank] = useState<any>({});
  const [theme, setTheme] = useState<any>({});
  const [emailCfg, setEmailCfg] = useState<any>({});
  const [emailStatus, setEmailStatus] = useState<any>({});
  const [ownerSummary, setOwnerSummary] = useState<any>({});
  const [emailHistory, setEmailHistory] = useState<any[]>([]);
  const [testRecipient, setTestRecipient] = useState('');

  // Staff, Sessions, Security Alerts & Developer Integrations
  const [staff, setStaff] = useState<any[]>([]);
  const [staffForbidden, setStaffForbidden] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditForbidden, setAuditForbidden] = useState(false);
  const [securityEvents, setSecurityEvents] = useState<any[]>([]);
  const [loginHistory, setLoginHistory] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [portalName, setPortalName] = useState('Authorized Support Team');
  const [createdIntegrationKey, setCreatedIntegrationKey] = useState<string | null>(null);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [newStaffPwd, setNewStaffPwd] = useState('');
  const [newStaffRole, setNewStaffRole] = useState('staff');
  const [newOwnerEmail, setNewOwnerEmail] = useState('olarindevictor046@gmail.com');
  const [ownerEmailBusy, setOwnerEmailBusy] = useState(false);

  const load = async () => {
    setErr(null);
    try {
      const sRes = await apiFetch<any>('/api/admin/settings');
      setBank(sRes.settings?.bank_transfer || {});
      setTheme(sRes.settings?.theme || {});
      setEmailCfg(sRes.settings?.email || {});
      setEmailStatus(sRes.emailStatus || {});
      setOwnerSummary(sRes.ownerSummary || {});

      if (mode === 'email') {
        try {
          const eRes = await apiFetch<any>('/api/admin/email/history');
          setEmailHistory(eRes.events || []);
          setTestRecipient(eRes.config?.testEmailRecipient || 'olarindevictor046@gmail.com');
        } catch {
          // non-owner/email roles won't fetch history
        }
      }

      if (mode === 'settings') {
        if (!isOwner) {
          setStaffForbidden(true);
          setAuditForbidden(true);
        } else {
          try {
            const [stRes, sessRes, secRes, intRes] = await Promise.all([
              apiFetch<any>('/api/admin/staff'),
              apiFetch<any>('/api/admin/sessions').catch(() => ({ sessions: [] })),
              apiFetch<any>('/api/admin/security-summary').catch(() => ({ events: [], logins: [] })),
              apiFetch<any>('/api/admin/developer-integrations').catch(() => ({ integrations: [] })),
            ]);
            setStaff(stRes.staff || []);
            setSessions(sessRes.sessions || []);
            setSecurityEvents(secRes.events || []);
            setLoginHistory(secRes.logins || []);
            setIntegrations(intRes.integrations || []);
            setStaffForbidden(false);
          } catch {
            setStaffForbidden(true);
          }
          try {
            const audRes = await apiFetch<any>('/api/admin/audit-logs');
            setAuditLogs(audRes.logs || []);
            setAuditForbidden(false);
          } catch {
            setAuditForbidden(true);
          }
        }
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
  }, [mode, section, isOwner]);

  const saveSetting = async (key: string, payload: any) => {
    setMsg(null);
    setErr(null);
    try {
      await apiFetch(`/api/admin/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      await onRefreshStorefront();
      setMsg(`Saved ${key.replace('_', ' ')} settings.`);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const sendTestEmail = async () => {
    setMsg(null);
    setErr(null);
    try {
      await apiFetch<any>('/api/admin/email/test', {
        method: 'POST',
        body: JSON.stringify({ recipient: testRecipient }),
      });
      setMsg('Test notification accepted for delivery.');
      await load();
    } catch (e: any) {
      setErr(sanitizeNotificationError(e.message));
      await load();
    }
  };

  const retryEmail = async (eventId: string) => {
    await apiFetch(`/api/admin/email/retry/${eventId}`, { method: 'POST' });
    await load();
  };

  const createStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await apiFetch('/api/admin/staff', {
        method: 'POST',
        body: JSON.stringify({
          name: newStaffName,
          email: newStaffEmail,
          password: newStaffPwd,
          role: newStaffRole,
        }),
      });
      setNewStaffName('');
      setNewStaffEmail('');
      setNewStaffPwd('');
      setMsg('Staff account created with server-enforced permissions.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const revokeSession = async (sessionId: string) => {
    await apiFetch(`/api/admin/sessions/${sessionId}`, { method: 'DELETE' });
    setMsg('Session revoked immediately.');
    await load();
  };

  const revokeMyOtherSessions = async () => {
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ revokedCount: number }>('/api/me/sessions/revoke-others', {
        method: 'POST',
      });
      setMsg(
        res.revokedCount > 0
          ? `Signed out ${res.revokedCount} other session(s) for your account.`
          : 'No other active sessions found for your account.'
      );
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const createIntegrationAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch<{ apiKey: string }>('/api/admin/developer-integrations', {
        method: 'POST',
        body: JSON.stringify({
          portalName,
          scopes: ['errors:read', 'errors:update', 'security:read', 'audit:read'],
          expiresInDays: 90,
        }),
      });
      setCreatedIntegrationKey(res.apiKey);
      setMsg('Technical support integration key generated. Copy it once now — it will not be shown again.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const revokeIntegrationAccess = async (id: string) => {
    setErr(null);
    await apiFetch(`/api/admin/developer-integrations/${id}`, { method: 'DELETE' });
    setMsg('Technical support integration key revoked immediately.');
    await load();
  };

  const requestOwnerEmailChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setOwnerEmailBusy(true);
    try {
      const res = await apiFetch<{ message?: string }>('/api/admin/owner/change-email', {
        method: 'POST',
        body: JSON.stringify({ newEmail: newOwnerEmail }),
      });
      setMsg(
        res.message ||
          'Verification steps initiated. Confirm via your current email first, then verify the new login email.'
      );
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setOwnerEmailBusy(false);
    }
  };

  const uploadBrandAsset = async (file: File, targetField: 'logoUrl' | 'faviconUrl' | 'heroImage') => {
    const form = new FormData();
    form.append('file', file);
    const res = await apiFetch<{ url: string }>('/api/admin/media/upload', {
      method: 'POST',
      body: form,
    });
    setTheme((prev: any) => ({ ...prev, [targetField]: res.url }));
    setMsg(`Uploaded asset for ${targetField}. Save changes to publish.`);
  };

  const renderEmailSection = () => (
    <div className="space-y-6">
      <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-[#172554]">Order Notifications</h2>
            <p className="text-xs text-slate-500">
              Admin alert recipient:{' '}
              <strong className="text-[#172554]">
                {emailStatus.resolvedAdminEmail || 'olarindevictor046@gmail.com'}
              </strong>{' '}
              · Notification service:{' '}
              <strong className={emailStatus.notificationServiceReady ? 'text-emerald-700' : 'text-[#9A2E1E]'}>
                {emailStatus.notificationServiceReady
                  ? 'Connected'
                  : emailStatus.hasSenderCredentials
                    ? 'Sender Email Needed'
                    : 'Needs Setup'}
              </strong>
            </p>
          </div>
          <button
            type="button"
            onClick={async () => {
              const res = await apiFetch<any>('/api/admin/email/process-queue', { method: 'POST' });
              setMsg(`Processed ${res.processed} queued notification(s).`);
              await load();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-[#172554]"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Process Notification Queue
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div>
            <label className="block font-semibold mb-1">Administrator Notification Email</label>
            <input
              type="email"
              value={emailCfg.adminNotificationEmail ?? 'olarindevictor046@gmail.com'}
              onChange={(e) => setEmailCfg({ ...emailCfg, adminNotificationEmail: e.target.value })}
              placeholder="olarindevictor046@gmail.com"
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="block font-semibold mb-1">Verified Sender Email</label>
            <input
              type="email"
              value={emailCfg.fromEmail || ''}
              onChange={(e) => setEmailCfg({ ...emailCfg, fromEmail: e.target.value })}
              placeholder="orders@yourdomain.com"
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="block font-semibold mb-1">Sender Display Name</label>
            <input
              type="text"
              value={emailCfg.fromName || 'SELLORA'}
              onChange={(e) => setEmailCfg({ ...emailCfg, fromName: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="block font-semibold mb-1">Test Email Recipient</label>
            <div className="flex gap-2">
              <input
                type="email"
                value={testRecipient}
                onChange={(e) => {
                  setTestRecipient(e.target.value);
                  setEmailCfg({ ...emailCfg, testEmailRecipient: e.target.value });
                }}
                placeholder="olarindevictor046@gmail.com"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
              />
              <button
                type="button"
                onClick={sendTestEmail}
                className="inline-flex items-center gap-1 rounded-lg border border-[#172554] px-3 py-2 font-semibold text-[#172554] hover:bg-[#172554] hover:text-[#B7F36B]"
              >
                <Send className="w-3.5 h-3.5" /> Test Email
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => saveSetting('email', emailCfg)}
          className="rounded-lg bg-[#172554] px-4 py-2 text-xs font-bold text-[#B7F36B]"
        >
          Save Email Configuration
        </button>
      </div>

      {/* Notification History Table */}
      <div className="rounded-xl bg-white border border-slate-200 overflow-x-auto">
        <div className="p-4 border-b border-slate-200 flex items-center gap-2 text-sm font-bold text-[#172554]">
          <Mail className="w-4 h-4" />
          <span>Order Notification History</span>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[#F5F7F4] text-left text-slate-500 border-b border-slate-200">
              <th className="p-3">Order / Type</th>
              <th className="p-3">Recipient</th>
              <th className="p-3">Subject</th>
              <th className="p-3">Status</th>
              <th className="p-3">Attempts</th>
              <th className="p-3">Timestamp</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {emailHistory.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-500">
                  No order notifications sent yet.
                </td>
              </tr>
            ) : (
              emailHistory.map((ev) => (
                <tr key={ev.event_id}>
                  <td className="p-3">
                    <div className="font-mono-tabular font-bold text-[#172554]">
                      {ev.order_number || ev.notification_type.replace(/_/g, ' ')}
                    </div>
                    <div className="text-[11px] text-slate-400 capitalize">
                      {ev.recipient_type}
                    </div>
                  </td>
                  <td className="p-3">{ev.recipient_email}</td>
                  <td className="p-3 max-w-xs truncate">{ev.subject}</td>
                  <td className="p-3">
                    <div className="font-semibold capitalize">
                      {ev.status === 'accepted_by_provider'
                        ? 'Dispatched'
                        : String(ev.status).replace(/_/g, ' ')}
                    </div>
                    {ev.last_error && (
                      <div className="text-[11px] text-[#9A2E1E]">
                        {sanitizeNotificationError(ev.last_error)}
                      </div>
                    )}
                  </td>
                  <td className="p-3 tabular-nums">
                    {ev.attempt_count}/{ev.max_attempts}
                  </td>
                  <td className="p-3 text-slate-500 tabular-nums">
                    {formatLagosDate(ev.created_at)}
                  </td>
                  <td className="p-3 text-right">
                    {(ev.status === 'failed' || ev.status === 'queued') && (
                      <button
                        type="button"
                        onClick={() => retryEmail(ev.event_id)}
                        className="text-[#172554] font-semibold underline"
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderAppearanceSection = () => (
    <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-5 text-xs">
      <h2 className="text-lg font-bold text-[#172554]">Appearance, Storefront Content & Policies</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block font-semibold mb-1">Announcement Bar Text</label>
          <input
            type="text"
            value={theme.announcementText || ''}
            onChange={(e) => setTheme({ ...theme, announcementText: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Hero Headline</label>
          <input
            type="text"
            value={theme.heroHeadline || ''}
            onChange={(e) => setTheme({ ...theme, heroHeadline: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block font-semibold mb-1">Hero Subtitle</label>
          <textarea
            rows={2}
            value={theme.heroSubtitle || ''}
            onChange={(e) => setTheme({ ...theme, heroSubtitle: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block font-semibold mb-1">Hero Banner Image URL</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={theme.heroImage || ''}
              onChange={(e) => setTheme({ ...theme, heroImage: e.target.value })}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
            />
            <label className="rounded-lg border border-slate-300 px-3 py-2 cursor-pointer hover:bg-slate-50 font-semibold">
              Upload
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadBrandAsset(f, 'heroImage');
                }}
              />
            </label>
          </div>
        </div>
        <div className="sm:col-span-2">
          <label className="block font-semibold mb-1">About Page Content</label>
          <textarea
            rows={3}
            value={theme.aboutContent || ''}
            onChange={(e) => setTheme({ ...theme, aboutContent: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Shipping & Delivery Policy</label>
          <textarea
            rows={2}
            value={theme.policies?.shipping || ''}
            onChange={(e) =>
              setTheme({ ...theme, policies: { ...(theme.policies || {}), shipping: e.target.value } })
            }
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Returns & Refund Policy</label>
          <textarea
            rows={2}
            value={theme.policies?.returns || ''}
            onChange={(e) =>
              setTheme({ ...theme, policies: { ...(theme.policies || {}), returns: e.target.value } })
            }
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Privacy Policy</label>
          <textarea
            rows={2}
            value={theme.policies?.privacy || ''}
            onChange={(e) =>
              setTheme({ ...theme, policies: { ...(theme.policies || {}), privacy: e.target.value } })
            }
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Terms & Conditions</label>
          <textarea
            rows={2}
            value={theme.policies?.terms || ''}
            onChange={(e) =>
              setTheme({ ...theme, policies: { ...(theme.policies || {}), terms: e.target.value } })
            }
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-6 pt-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={Boolean(theme.announcementEnabled)}
            onChange={(e) => setTheme({ ...theme, announcementEnabled: e.target.checked })}
          />
          Show Announcement Bar
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={Boolean(theme.maintenanceMode)}
            onChange={(e) => setTheme({ ...theme, maintenanceMode: e.target.checked })}
          />
          Enable Storefront Maintenance Mode
        </label>
      </div>
      <button
        type="button"
        onClick={() => saveSetting('theme', theme)}
        className="rounded-lg bg-[#172554] px-5 py-2.5 font-bold text-[#B7F36B]"
      >
        Publish Appearance & Policy Changes
      </button>
    </div>
  );

  const SETTINGS_NAV: Array<{ id: SettingsSection; label: string; icon: any }> = [
    { id: 'profile', label: 'Store Profile', icon: Building2 },
    { id: 'staff', label: 'Owner & Staff', icon: Shield },
    { id: 'payments', label: 'Payments & Banking', icon: Landmark },
    ...(isOwner ? [{ id: 'security' as const, label: 'Security & Support Access', icon: ShieldAlert }] : []),
  ];

  return (
    <div className="space-y-6">
      {msg && (
        <div className="rounded-lg bg-[#B7F36B]/30 border border-[#172554]/20 px-4 py-2.5 text-xs font-semibold text-[#172554]">
          {msg}
        </div>
      )}
      {err && (
        <div className="rounded-lg bg-[#F47B68]/15 border border-[#F47B68]/40 px-4 py-2.5 text-xs font-semibold text-[#9A2E1E]">
          {err}
        </div>
      )}

      {mode === 'email' && renderEmailSection()}
      {mode === 'theme' && renderAppearanceSection()}

      {mode === 'settings' && (
        <div className="space-y-6">
          {/* Store Settings Nav */}
          <div className="flex flex-wrap gap-1.5 p-1.5 bg-white border border-slate-200 rounded-xl">
            {SETTINGS_NAV.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                    section === item.id
                      ? 'bg-[#172554] text-[#B7F36B]'
                      : 'text-slate-600 hover:bg-[#F5F7F4] hover:text-[#172554]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          {/* Store Profile */}
          {section === 'profile' && (
            <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4 text-xs">
              <h2 className="text-lg font-bold text-[#172554]">Store Profile</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold mb-1">Store Name</label>
                  <input
                    type="text"
                    value={theme.storeName || 'SELLORA'}
                    onChange={(e) => setTheme({ ...theme, storeName: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Tagline</label>
                  <input
                    type="text"
                    value={theme.tagline || 'Commerce without limits.'}
                    onChange={(e) => setTheme({ ...theme, tagline: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-semibold mb-1">Store Description</label>
                  <textarea
                    rows={2}
                    value={theme.storeDescription || ''}
                    onChange={(e) => setTheme({ ...theme, storeDescription: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Public Contact Email</label>
                  <input
                    type="email"
                    value={theme.contactEmail || ''}
                    onChange={(e) => setTheme({ ...theme, contactEmail: e.target.value })}
                    placeholder="support@sellora.store"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Public Contact Phone</label>
                  <input
                    type="text"
                    value={theme.contactPhone || ''}
                    onChange={(e) => setTheme({ ...theme, contactPhone: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Business Location</label>
                  <input
                    type="text"
                    value={theme.contactAddress || 'Lagos, Nigeria'}
                    onChange={(e) => setTheme({ ...theme, contactAddress: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Store Status</label>
                  <select
                    value={theme.maintenanceMode ? 'maintenance' : 'active'}
                    onChange={(e) =>
                      setTheme({
                        ...theme,
                        storeStatus: e.target.value,
                        maintenanceMode: e.target.value === 'maintenance',
                      })
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    <option value="active">Active (Open for Orders)</option>
                    <option value="maintenance">Maintenance Mode</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Logo URL (optional override)</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={theme.logoUrl || ''}
                      onChange={(e) => setTheme({ ...theme, logoUrl: e.target.value })}
                      placeholder="Default geometric SELLORA mark"
                      className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
                    />
                    <label className="rounded-lg border border-slate-300 px-3 py-2 cursor-pointer hover:bg-slate-50 font-semibold">
                      Upload
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) uploadBrandAsset(f, 'logoUrl');
                        }}
                      />
                    </label>
                  </div>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Favicon URL (optional override)</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={theme.faviconUrl || ''}
                      onChange={(e) => setTheme({ ...theme, faviconUrl: e.target.value })}
                      placeholder="/icons/icon-192x192.png"
                      className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
                    />
                    <label className="rounded-lg border border-slate-300 px-3 py-2 cursor-pointer hover:bg-slate-50 font-semibold">
                      Upload
                      <input
                        type="file"
                        accept="image/png,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) uploadBrandAsset(f, 'faviconUrl');
                        }}
                      />
                    </label>
                  </div>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Store Currency</label>
                  <input
                    type="text"
                    readOnly
                    value="NGN (Nigerian Naira)"
                    className="w-full rounded-lg border border-slate-200 bg-[#F5F7F4] px-3 py-2 text-slate-600"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Time Zone</label>
                  <input
                    type="text"
                    readOnly
                    value="Africa/Lagos (WAT, UTC+1)"
                    className="w-full rounded-lg border border-slate-200 bg-[#F5F7F4] px-3 py-2 text-slate-600"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => saveSetting('theme', theme)}
                className="rounded-lg bg-[#172554] px-5 py-2.5 font-bold text-[#B7F36B]"
              >
                Save Store Profile
              </button>
            </div>
          )}

          {/* Owner & Staff */}
          {section === 'staff' && (
            <div className="space-y-6 text-xs">
              {!isOwner ? (
                <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-2">
                  <h2 className="text-base font-bold text-[#172554]">Owner & Staff Management</h2>
                  <p className="text-slate-600">
                    Staff accounts, active sessions, and security activity logs are restricted to the store owner.
                  </p>
                </div>
              ) : (
                <>
                  <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4">
                    <h2 className="text-lg font-bold text-[#172554]">Store Owner Identity</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-[#F5F7F4] border border-slate-200 rounded-xl p-4">
                      <div>
                        <span className="text-slate-500 block">Store Owner Email</span>
                        <strong className="text-sm text-[#172554]">
                          {ownerSummary.designatedOwnerEmail || 'olarindevictor046@gmail.com'}
                        </strong>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Ownership Status</span>
                        <strong className="text-sm text-[#172554]">
                          {ownerSummary.ownerExists
                            ? `Verified (${ownerSummary.ownerRecord?.email || 'Active'})`
                            : 'Active'}
                        </strong>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Sign-In Methods</span>
                        <strong className="text-sm text-emerald-700">
                          {ownerSummary.googleOAuthConfigured
                            ? 'Google Sign-In & Email / Password'
                            : 'Email & Password'}
                        </strong>
                      </div>
                    </div>

                    {ownerSummary.emailMigrationPending && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                        Your active login account ({ownerSummary.ownerRecord?.email}) does not yet match the
                        configured administrator login email ({ownerSummary.designatedOwnerEmail}). Use the verified
                        email change form below to complete verification without affecting store history.
                      </div>
                    )}

                    <form
                      onSubmit={requestOwnerEmailChange}
                      className="border-t border-slate-200 pt-4 space-y-2"
                    >
                      <label className="block font-semibold text-[#172554]">
                        Change Administrator Login Email (Verified)
                      </label>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="email"
                          required
                          value={newOwnerEmail}
                          onChange={(e) => setNewOwnerEmail(e.target.value)}
                          placeholder="new-admin@example.com"
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
                        />
                        <button
                          type="submit"
                          disabled={ownerEmailBusy}
                          className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B] disabled:opacity-60"
                        >
                          {ownerEmailBusy ? 'Sending Verification...' : 'Send Verification Link'}
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Updating the administrator login email preserves your account ID and store history, requires
                        email verification before taking effect, and clears prior external sign-in links for security.
                      </p>
                    </form>
                  </div>

                  <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4">
                    <div className="flex items-center gap-2 text-base font-bold text-[#172554]">
                      <Shield className="w-4 h-4" />
                      <span>Staff Accounts & Roles</span>
                    </div>
                    {staffForbidden ? (
                      <p className="text-slate-600">
                        Restricted: Only the store owner can view or manage staff roles.
                      </p>
                    ) : (
                      <>
                        <form onSubmit={createStaff} className="grid grid-cols-1 sm:grid-cols-5 gap-2">
                          <input
                            type="text"
                            required
                            value={newStaffName}
                            onChange={(e) => setNewStaffName(e.target.value)}
                            placeholder="Staff Name"
                            className="rounded-lg border border-slate-300 px-3 py-2"
                          />
                          <input
                            type="email"
                            required
                            value={newStaffEmail}
                            onChange={(e) => setNewStaffEmail(e.target.value)}
                            placeholder="Email"
                            className="rounded-lg border border-slate-300 px-3 py-2"
                          />
                          <input
                            type="password"
                            required
                            minLength={8}
                            value={newStaffPwd}
                            onChange={(e) => setNewStaffPwd(e.target.value)}
                            placeholder="Initial Password"
                            className="rounded-lg border border-slate-300 px-3 py-2"
                          />
                          <select
                            value={newStaffRole}
                            onChange={(e) => setNewStaffRole(e.target.value)}
                            className="rounded-lg border border-slate-300 px-3 py-2"
                          >
                            <option value="staff">Staff (General Operations)</option>
                            <option value="admin">Administrator</option>
                            <option value="manager">Manager</option>
                            <option value="order_staff">Order Staff</option>
                            <option value="inventory_staff">Inventory Staff</option>
                            <option value="support_staff">Customer Support Staff</option>
                          </select>
                          <button
                            type="submit"
                            className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
                          >
                            Add Staff
                          </button>
                        </form>
                        <div className="divide-y divide-slate-100">
                          {staff.map((s) => (
                            <div key={s.id} className="py-2.5 flex justify-between items-center gap-3">
                              <div>
                                <span className="font-bold text-[#172554]">{s.name}</span> ({s.email})
                                <div className="text-[11px] text-slate-400 capitalize">
                                  {s.role.replace(/_/g, ' ')} · {s.isActive ? 'Active' : 'Suspended'}
                                </div>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="capitalize font-semibold">{s.role.replace(/_/g, ' ')}</span>
                                {s.role !== 'owner' && (
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      await apiFetch(`/api/admin/staff/${s.id}`, {
                                        method: 'PATCH',
                                        body: JSON.stringify({ isActive: !s.isActive }),
                                      });
                                      await load();
                                    }}
                                    className="text-[#172554] underline"
                                  >
                                    {s.isActive ? 'Deactivate' : 'Activate'}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {!staffForbidden && (
                    <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-3">
                      <div className="flex items-center gap-2 text-sm font-bold text-[#172554]">
                        <Activity className="w-4 h-4" />
                        <span>Active Account Sessions</span>
                      </div>
                      {sessions.length === 0 ? (
                        <p className="text-slate-500">No active sessions recorded.</p>
                      ) : (
                        <div className="divide-y divide-slate-100 max-h-56 overflow-y-auto">
                          {sessions.map((sess) => (
                            <div key={sess.id} className="py-2 flex justify-between items-center gap-4">
                              <div>
                                <div className="font-semibold text-[#172554]">
                                  {sess.email} ({sess.role})
                                </div>
                                <div className="text-[11px] text-slate-400">
                                  Started {formatLagosDate(sess.createdAt)} · Expires {formatLagosDate(sess.expiresAt)}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => revokeSession(sess.id)}
                                className="rounded border border-[#F47B68] px-2.5 py-1 text-[11px] font-semibold text-[#9A2E1E]"
                              >
                                Revoke
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {!auditForbidden && (
                    <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-3">
                      <h3 className="text-sm font-bold text-[#172554]">Account Activity Log</h3>
                      <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
                        {auditLogs.map((l) => (
                          <div key={l.id} className="py-2 flex justify-between gap-4">
                            <div>
                              <span className="font-mono-tabular font-bold text-[#172554]">{l.action}</span>{' '}
                              <span className="text-slate-600">
                                by {l.actor_email || 'system'} ({l.actor_role || '—'})
                              </span>
                            </div>
                            <span className="text-slate-400 tabular-nums shrink-0">
                              {formatLagosDate(l.created_at)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Payments & Banking */}
          {section === 'payments' && (
            <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4 text-xs">
              <h2 className="text-lg font-bold text-[#172554]">Payments & Nigerian Banking</h2>
              <p className="text-slate-500">
                Configure your Nigerian business bank account for customer bank transfer checkout.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block font-semibold mb-1">Bank Name</label>
                  <input
                    type="text"
                    value={bank.bankName || ''}
                    onChange={(e) => setBank({ ...bank, bankName: e.target.value })}
                    placeholder="e.g. Zenith Bank / GTBank"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Account Name</label>
                  <input
                    type="text"
                    value={bank.accountName || ''}
                    onChange={(e) => setBank({ ...bank, accountName: e.target.value })}
                    placeholder="Business Account Name"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Account Number (NUBAN)</label>
                  <input
                    type="text"
                    value={bank.accountNumber || ''}
                    onChange={(e) => setBank({ ...bank, accountNumber: e.target.value })}
                    placeholder="10-digit NUBAN"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
                  />
                </div>
                <div className="sm:col-span-3">
                  <label className="block font-semibold mb-1">Payment Instructions</label>
                  <input
                    type="text"
                    value={bank.paymentInstructions || ''}
                    onChange={(e) => setBank({ ...bank, paymentInstructions: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  saveSetting('bank_transfer', {
                    ...bank,
                    configured: Boolean(bank.bankName && bank.accountName && bank.accountNumber),
                  })
                }
                className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
              >
                Save Bank Transfer Details
              </button>
            </div>
          )}

          {/* Security Alerts & Authorized Technical Access (Owner Only) */}
          {section === 'security' && isOwner && (
            <div className="space-y-6 text-xs">
              <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold text-[#172554]">Account Protection & Sessions</h2>
                    <p className="text-slate-500">
                      Sign-in verification alerts and unauthorized-device response stay active for all store accounts.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={revokeMyOtherSessions}
                    className="rounded-lg border border-[#F47B68] px-3.5 py-2 font-semibold text-[#9A2E1E] hover:bg-[#F47B68]/10"
                  >
                    Sign Out Other Devices
                  </button>
                </div>
              </div>

              <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4">
                <div className="flex items-center gap-2 text-base font-bold text-[#172554]">
                  <KeyRound className="w-4 h-4" />
                  <span>Authorized Technical Support Access</span>
                </div>
                <p className="text-slate-500">
                  Issue revocable, read-scoped diagnostic access keys when granting troubleshooting permission.
                  Technical error traces remain isolated from your store dashboard and customer orders.
                </p>

                {createdIntegrationKey && (
                  <div className="rounded-xl bg-[#F5F7F4] border border-[#172554]/30 p-4 space-y-2">
                    <div className="font-bold text-[#172554]">
                      New Support Access Key (shown once only — store securely)
                    </div>
                    <div className="font-mono-tabular break-all bg-white border border-slate-200 rounded px-3 py-2 text-[#172554]">
                      {createdIntegrationKey}
                    </div>
                    <button
                      type="button"
                      onClick={() => setCreatedIntegrationKey(null)}
                      className="text-[11px] font-semibold text-slate-600 underline"
                    >
                      Hide Key
                    </button>
                  </div>
                )}

                <form onSubmit={createIntegrationAccess} className="flex flex-wrap gap-2">
                  <input
                    type="text"
                    required
                    value={portalName}
                    onChange={(e) => setPortalName(e.target.value)}
                    placeholder="Authorized support team name"
                    className="flex-1 min-w-[200px] rounded-lg border border-slate-300 px-3 py-2"
                  />
                  <button
                    type="submit"
                    className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
                  >
                    Generate 90-Day Diagnostic Key
                  </button>
                </form>

                {integrations.length > 0 && (
                  <div className="divide-y divide-slate-100">
                    {integrations.map((intg) => (
                      <div key={intg.id} className="py-2.5 flex items-center justify-between gap-3">
                        <div>
                          <div className="font-semibold text-[#172554]">
                            {intg.portal_name}{' '}
                            <span className="font-mono-tabular text-slate-500">({intg.key_prefix}...)</span>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {intg.is_active ? 'Active' : 'Revoked'} · Created {formatLagosDate(intg.created_at)}
                            {intg.expires_at ? ` · Expires ${formatLagosDate(intg.expires_at)}` : ''}
                          </div>
                        </div>
                        {Boolean(intg.is_active) && (
                          <button
                            type="button"
                            onClick={() => revokeIntegrationAccess(intg.id)}
                            className="rounded border border-[#F47B68] px-2.5 py-1 text-[11px] font-semibold text-[#9A2E1E]"
                          >
                            Revoke Access
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-3">
                  <h3 className="text-sm font-bold text-[#172554]">Recent Security Alerts</h3>
                  {securityEvents.length === 0 ? (
                    <p className="text-slate-500">No security alerts recorded yet.</p>
                  ) : (
                    <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto">
                      {securityEvents.map((ev) => (
                        <div key={ev.id} className="py-2 space-y-0.5">
                          <div className="flex justify-between font-semibold text-[#172554]">
                            <span className="font-mono-tabular">{ev.event_ref}</span>
                            <span className="uppercase text-[11px]">{ev.severity}</span>
                          </div>
                          <div className="text-slate-600 capitalize">
                            {String(ev.event_category).replace(/_/g, ' ')} ·{' '}
                            {ev.device_summary || ev.email || 'Account security notice'}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            Status: {String(ev.status).replace(/_/g, ' ')} · {formatLagosDate(ev.created_at)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-3">
                  <h3 className="text-sm font-bold text-[#172554]">Recent Sign-In Activity</h3>
                  {loginHistory.length === 0 ? (
                    <p className="text-slate-500">No sign-in records recorded yet.</p>
                  ) : (
                    <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto">
                      {loginHistory.map((lg) => (
                        <div key={lg.id} className="py-2 space-y-0.5">
                          <div className="flex justify-between font-semibold text-[#172554]">
                            <span>{lg.email}</span>
                            <span className="capitalize">{lg.outcome}</span>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {lg.device_summary} · {lg.approx_location || 'Location unavailable'}
                            {lg.is_new_device ? ' · New device' : ''}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {formatLagosDate(lg.created_at)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
