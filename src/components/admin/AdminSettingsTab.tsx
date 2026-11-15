import React, { useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Building2,
  Globe,
  Landmark,
  Mail,
  Palette,
  Plug,
  RefreshCw,
  Send,
  Shield,
  Truck,
} from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { formatLagosDate } from '../../shared/types';

type SettingsSection =
  | 'profile'
  | 'staff'
  | 'payments'
  | 'delivery'
  | 'email'
  | 'seo'
  | 'analytics'
  | 'integrations'
  | 'appearance';

export const AdminSettingsTab: React.FC<{
  mode: 'email' | 'theme' | 'settings';
  capabilities: any;
  onRefreshStorefront: () => Promise<void>;
}> = ({ mode, capabilities, onRefreshStorefront }) => {
  const [section, setSection] = useState<SettingsSection>('profile');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Settings objects
  const [bank, setBank] = useState<any>({});
  const [theme, setTheme] = useState<any>({});
  const [seo, setSeo] = useState<any>({});
  const [emailCfg, setEmailCfg] = useState<any>({});
  const [emailStatus, setEmailStatus] = useState<any>({});
  const [ownerSummary, setOwnerSummary] = useState<any>({});
  const [deliverySummary, setDeliverySummary] = useState<any>({});
  const [seoSummary, setSeoSummary] = useState<any>({});
  const [integrationStatus, setIntegrationStatus] = useState<any[]>([]);
  const [emailHistory, setEmailHistory] = useState<any[]>([]);
  const [testRecipient, setTestRecipient] = useState('');

  // Staff, Sessions & Audit
  const [staff, setStaff] = useState<any[]>([]);
  const [staffForbidden, setStaffForbidden] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditForbidden, setAuditForbidden] = useState(false);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [newStaffPwd, setNewStaffPwd] = useState('');
  const [newStaffRole, setNewStaffRole] = useState('staff');

  const load = async () => {
    setErr(null);
    try {
      const sRes = await apiFetch<any>('/api/admin/settings');
      setBank(sRes.settings?.bank_transfer || {});
      setTheme(sRes.settings?.theme || {});
      setSeo(sRes.settings?.seo || {});
      setEmailCfg(sRes.settings?.email || {});
      setEmailStatus(sRes.emailStatus || {});
      setOwnerSummary(sRes.ownerSummary || {});
      setDeliverySummary(sRes.deliverySummary || {});
      setSeoSummary(sRes.seoSummary || {});
      setIntegrationStatus(sRes.integrationStatus || []);

      if (mode === 'email' || section === 'email') {
        try {
          const eRes = await apiFetch<any>('/api/admin/email/history');
          setEmailHistory(eRes.events || []);
          setTestRecipient(eRes.config?.testEmailRecipient || 'olarindevictor3@gmail.com');
        } catch {
          // non-owner/email roles won't fetch history
        }
      }

      if (mode === 'settings') {
        try {
          const [stRes, sessRes] = await Promise.all([
            apiFetch<any>('/api/admin/staff'),
            apiFetch<any>('/api/admin/sessions').catch(() => ({ sessions: [] })),
          ]);
          setStaff(stRes.staff || []);
          setSessions(sessRes.sessions || []);
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
    } catch (e: any) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
  }, [mode, section]);

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
      const res = await apiFetch<any>('/api/admin/email/test', {
        method: 'POST',
        body: JSON.stringify({ recipient: testRecipient }),
      });
      setMsg(
        `Test email accepted by Brevo (Message ID: ${res.messageId || 'recorded'}). Note: Provider acceptance is recorded separately from delivery confirmation.`
      );
      await load();
    } catch (e: any) {
      setErr(e.message);
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
            <h2 className="text-lg font-bold text-[#172554]">
              Email & Notifications (Brevo Transactional API)
            </h2>
            <p className="text-xs text-slate-500">
              Default admin alert recipient:{' '}
              <strong className="text-[#172554]">
                {emailStatus.resolvedAdminEmail || 'olarindevictor3@gmail.com'}
              </strong>{' '}
              · API Key status:{' '}
              <strong className={emailStatus.hasBrevoApiKey ? 'text-emerald-700' : 'text-[#9A2E1E]'}>
                {emailStatus.hasBrevoApiKey ? 'BREVO_API_KEY Configured' : 'BREVO_API_KEY Missing in Server Env'}
              </strong>
            </p>
          </div>
          <button
            type="button"
            onClick={async () => {
              const res = await apiFetch<any>('/api/admin/email/process-queue', { method: 'POST' });
              setMsg(`Processed ${res.processed} queued email event(s).`);
              await load();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-[#172554]"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Process Outbox Queue
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div>
            <label className="block font-semibold mb-1">Administrator Notification Email</label>
            <input
              type="email"
              value={emailCfg.adminNotificationEmail ?? 'olarindevictor3@gmail.com'}
              onChange={(e) => setEmailCfg({ ...emailCfg, adminNotificationEmail: e.target.value })}
              placeholder="olarindevictor3@gmail.com"
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="block font-semibold mb-1">Verified Sender Email (Brevo)</label>
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
                placeholder="olarindevictor3@gmail.com"
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
          <span>Email Notification History & Outbox</span>
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
                  No email notification events logged yet.
                </td>
              </tr>
            ) : (
              emailHistory.map((ev) => (
                <tr key={ev.event_id}>
                  <td className="p-3">
                    <div className="font-mono-tabular font-bold text-[#172554]">
                      {ev.order_number || ev.notification_type}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {ev.recipient_type} · {ev.event_id.slice(0, 12)}
                    </div>
                  </td>
                  <td className="p-3">{ev.recipient_email}</td>
                  <td className="p-3 max-w-xs truncate">{ev.subject}</td>
                  <td className="p-3">
                    <div className="font-semibold capitalize">
                      {String(ev.status).replace(/_/g, ' ')}
                    </div>
                    {ev.provider_message_id && (
                      <div className="text-[10px] font-mono-tabular text-slate-400">
                        ID: {ev.provider_message_id}
                      </div>
                    )}
                    {ev.last_error && (
                      <div className="text-[11px] text-[#9A2E1E]">{ev.last_error}</div>
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
    { id: 'profile', label: 'A. Store Profile', icon: Building2 },
    { id: 'staff', label: 'B. Owner & Staff', icon: Shield },
    { id: 'payments', label: 'C. Payments & Banking', icon: Landmark },
    { id: 'delivery', label: 'D. Delivery & Shipping', icon: Truck },
    { id: 'email', label: 'E. Email & Notifications', icon: Mail },
    { id: 'seo', label: 'F. SEO & Search Console', icon: Globe },
    { id: 'analytics', label: 'G. Analytics (GA4)', icon: BarChart3 },
    { id: 'integrations', label: 'H. Integrations', icon: Plug },
    { id: 'appearance', label: 'I. Appearance & Content', icon: Palette },
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
          {/* 9-Section Settings Centre Nav */}
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

          {/* A. Store Profile */}
          {section === 'profile' && (
            <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4 text-xs">
              <h2 className="text-lg font-bold text-[#172554]">A. Store Profile</h2>
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

          {/* B. Owner & Staff */}
          {section === 'staff' && (
            <div className="space-y-6 text-xs">
              <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-3">
                <h2 className="text-lg font-bold text-[#172554]">B. Official Store Owner Identity</h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-[#F5F7F4] border border-slate-200 rounded-xl p-4">
                  <div>
                    <span className="text-slate-500 block">Designated Owner Email</span>
                    <strong className="text-sm text-[#172554]">
                      {ownerSummary.designatedOwnerEmail || 'olarindevictor3@gmail.com'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Ownership Status</span>
                    <strong className="text-sm text-[#172554]">
                      {ownerSummary.ownerExists
                        ? `Verified (${ownerSummary.ownerRecord?.email || 'Active'})`
                        : 'Awaiting First Sign-In'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Sign-In Methods</span>
                    <strong className="text-sm text-emerald-700">
                      {ownerSummary.googleOAuthConfigured
                        ? 'Google OAuth & Email / Password'
                        : 'Email / Password (Google OAuth awaiting credentials)'}
                    </strong>
                  </div>
                </div>
              </div>

              <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4">
                <div className="flex items-center gap-2 text-base font-bold text-[#172554]">
                  <Shield className="w-4 h-4" />
                  <span>Staff Roles, Invitations & Backend Permissions (Owner Only)</span>
                </div>
                {staffForbidden ? (
                  <p className="text-slate-600">
                    Restricted: Only the verified store owner can view or manage staff and admin roles.
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
                            <div className="text-[11px] text-slate-400">
                              {(s.permissions || []).length} permission(s) ·{' '}
                              {s.isActive ? 'Active' : 'Suspended'}
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="capitalize font-semibold">{s.role.replace('_', ' ')}</span>
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

              <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-3">
                <h3 className="text-sm font-bold text-[#172554]">Security & Admin Audit Log (Owner Only)</h3>
                {auditForbidden ? (
                  <p className="text-slate-600">
                    Restricted: Security audit logs are viewable only by the store owner.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
                    {auditLogs.map((l) => (
                      <div key={l.id} className="py-2 flex justify-between gap-4">
                        <div>
                          <span className="font-mono-tabular font-bold text-[#172554]">{l.action}</span>{' '}
                          <span className="text-slate-600">
                            by {l.actor_email || 'system'} ({l.actor_role || '—'}) on {l.target_type}{' '}
                            {l.target_id}
                          </span>
                        </div>
                        <span className="text-slate-400 tabular-nums shrink-0">
                          {formatLagosDate(l.created_at)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* C. Payments & Banking */}
          {section === 'payments' && (
            <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4 text-xs">
              <h2 className="text-lg font-bold text-[#172554]">C. Payments & Nigerian Banking</h2>
              <p className="text-slate-500">
                Configure your genuine Nigerian business bank account for manual transfer checkout. Never fabricated automatically.
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

          {/* D. Delivery & Shipping Summary */}
          {section === 'delivery' && (
            <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4 text-xs">
              <h2 className="text-lg font-bold text-[#172554]">D. Delivery & Nigerian Shipping Zones</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-[#F5F7F4] border border-slate-200 rounded-xl p-4">
                <div>
                  <span className="text-slate-500 block">Enabled State/LGA Zones</span>
                  <strong className="text-xl text-[#172554] tabular-nums">
                    {deliverySummary.enabledZones ?? 0}
                  </strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Covered Nigerian States</span>
                  <strong className="text-xl text-[#172554] tabular-nums">
                    {deliverySummary.coveredStates ?? 0}
                  </strong>
                </div>
              </div>
              <p className="text-slate-600 leading-relaxed">
                Checkout fails closed and never invents delivery charges for unconfigured States or LGAs. Open the <strong>Delivery Zones</strong> tab in the admin navigation bar to add or adjust State/LGA shipping rates, couriers, and free-shipping thresholds.
              </p>
            </div>
          )}

          {/* E. Email & Notifications */}
          {section === 'email' && renderEmailSection()}

          {/* F. SEO & Google Search Console */}
          {section === 'seo' && (
            <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-[#172554]">F. SEO & Google Search Console</h2>
                  <p className="text-slate-500">
                    Dynamic sitemap, robots rules, canonical URLs, JSON-LD structured data, and HTML verification meta tag.
                  </p>
                </div>
                <div className="flex gap-2">
                  <a
                    href="/sitemap.xml"
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold text-[#172554] hover:bg-slate-50"
                  >
                    View /sitemap.xml
                  </a>
                  <a
                    href="/robots.txt"
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold text-[#172554] hover:bg-slate-50"
                  >
                    View /robots.txt
                  </a>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-[#F5F7F4] border border-slate-200 rounded-xl p-4">
                <div>
                  <span className="text-slate-500 block">Active Products With Custom SEO</span>
                  <strong className="text-sm text-[#172554]">
                    {seoSummary.productsWithSeo ?? 0} / {seoSummary.activeProducts ?? 0}
                  </strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Search Console Verification Tag</span>
                  <strong className={seo.googleSiteVerification ? 'text-emerald-700 text-sm' : 'text-amber-700 text-sm'}>
                    {seo.googleSiteVerification ? 'Configured in <head>' : 'Not Set Yet'}
                  </strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Public Store Indexing</span>
                  <strong className="text-sm text-[#172554]">
                    {seo.indexingEnabled !== false ? 'index, follow' : 'noindex, nofollow'}
                  </strong>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold mb-1">Global Site Title</label>
                  <input
                    type="text"
                    value={seo.siteTitle || ''}
                    onChange={(e) => setSeo({ ...seo, siteTitle: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Canonical Production Domain</label>
                  <input
                    type="url"
                    value={seo.canonicalBaseUrl || ''}
                    onChange={(e) => setSeo({ ...seo, canonicalBaseUrl: e.target.value })}
                    placeholder="https://sellora.example.com"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-semibold mb-1">Global Meta Description</label>
                  <textarea
                    rows={2}
                    value={seo.metaDescription || ''}
                    onChange={(e) => setSeo({ ...seo, metaDescription: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">
                    Google Search Console Verification Meta Token
                  </label>
                  <input
                    type="text"
                    value={seo.googleSiteVerification || ''}
                    onChange={(e) => setSeo({ ...seo, googleSiteVerification: e.target.value })}
                    placeholder="Paste token from <meta name='google-site-verification' content='...'>"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Default Social Share / OG Image</label>
                  <input
                    type="text"
                    value={seo.defaultOgImage || ''}
                    onChange={(e) => setSeo({ ...seo, defaultOgImage: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={seo.indexingEnabled !== false}
                  onChange={(e) => setSeo({ ...seo, indexingEnabled: e.target.checked })}
                />
                Allow search engines to index public storefront, product, and category pages (admin/account/checkout/API always remain noindex)
              </label>

              <div className="rounded-lg border border-slate-200 bg-[#F5F7F4] p-4 space-y-1.5 text-slate-600">
                <div className="font-bold text-[#172554]">Search Console Submission Steps</div>
                <p>1. Open Google Search Console, add a URL prefix property matching your canonical domain, and choose the HTML tag verification method.</p>
                <p>2. Paste the verification token above and click Save SEO Settings (or set GOOGLE_SITE_VERIFICATION in Cloudflare environment vars).</p>
                <p>3. In Search Console → Sitemaps, submit <code className="font-mono-tabular">sitemap.xml</code>.</p>
              </div>

              <button
                type="button"
                onClick={() => saveSetting('seo', seo)}
                className="rounded-lg bg-[#172554] px-5 py-2.5 font-bold text-[#B7F36B]"
              >
                Save SEO Settings
              </button>
            </div>
          )}

          {/* G. Analytics & Insights (GA4) */}
          {section === 'analytics' && (
            <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4 text-xs">
              <h2 className="text-lg font-bold text-[#172554]">G. Google Analytics 4 (GA4) & Telemetry</h2>
              <p className="text-slate-600">
                Tracks anonymized SPA page views, product views, add-to-bag, begin-checkout, and strictly confirmed bank transfer purchases (<code className="font-mono-tabular">payment_confirmed</code> only). Never sends emails, phone numbers, or customer addresses to GA4.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold mb-1">GA4 Measurement ID</label>
                  <input
                    type="text"
                    value={seo.gaMeasurementId || ''}
                    onChange={(e) => setSeo({ ...seo, gaMeasurementId: e.target.value.trim() })}
                    placeholder="G-XXXXXXXXXX"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
                  />
                </div>
                <div className="rounded-lg bg-[#F5F7F4] border border-slate-200 p-3">
                  <div className="text-slate-500">Current Tracking State</div>
                  <strong className={seo.gaMeasurementId ? 'text-emerald-700' : 'text-amber-700'}>
                    {seo.gaMeasurementId
                      ? `GA4 Active (${seo.gaMeasurementId}) + D1 First-Party Insights`
                      : 'GA4 Optional ID Not Set (First-party D1 Funnel Active)'}
                  </strong>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-[#F5F7F4] p-4 text-slate-600">
                External GA4 historical Data API reporting requires service-account credentials and is viewed directly inside analytics.google.com. Real first-party traffic & conversion funnel metrics are recorded in D1 and displayed in the <strong>Analytics & Profit</strong> tab.
              </div>
              <button
                type="button"
                onClick={() => saveSetting('seo', seo)}
                className="rounded-lg bg-[#172554] px-5 py-2.5 font-bold text-[#B7F36B]"
              >
                Save Analytics Configuration
              </button>
            </div>
          )}

          {/* H. Integrations */}
          {section === 'integrations' && (
            <div className="rounded-xl bg-white border border-slate-200 p-6 space-y-4 text-xs">
              <h2 className="text-lg font-bold text-[#172554]">H. Connected Services & Integrations</h2>
              <p className="text-slate-500">
                Real environment readiness derived from server bindings. Secrets are never exposed to the browser.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {integrationStatus.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-xl border border-slate-200 bg-[#F5F7F4] p-4 flex items-start justify-between gap-3"
                  >
                    <div>
                      <div className="font-bold text-[#172554]">{item.name}</div>
                      <p className="text-slate-600 mt-0.5">{item.detail}</p>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded font-semibold uppercase text-[10px] shrink-0 ${
                        item.status === 'connected'
                          ? 'bg-emerald-100 text-emerald-800'
                          : item.status === 'awaiting_credentials'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      {String(item.status).replace(/_/g, ' ')}
                    </span>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-slate-200 p-3 text-slate-600">
                Optional Gemini AI Integration:{' '}
                <strong>
                  {capabilities?.aiConfigured
                    ? 'Configured on server (strictly non-financial).'
                    : 'Not configured (100% independent free-tier operation).'}
                </strong>
              </div>

              <div className="rounded-xl border border-slate-200 bg-[#F5F7F4] p-4 space-y-2 text-slate-700">
                <div className="font-bold text-[#172554]">
                  Google Auth Platform Branding & OAuth Client Setup
                </div>
                <p className="text-slate-600 leading-relaxed">
                  Google displays the consent screen app name, logo, and verified domain directly from your Google Cloud Console{' '}
                  <strong>Google Auth Platform → Branding / Audience / Clients</strong> configuration (not client-side HTML). Until a custom domain is verified and published in Google Cloud, Google displays the active runtime hostname.
                </p>
                {(() => {
                  const origin = typeof window !== 'undefined' ? window.location.origin : '';
                  return (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1 font-mono-tabular text-[11px]">
                      <div className="rounded-lg bg-white border border-slate-200 p-2.5">
                        <span className="text-slate-400 block font-sans">App Name & Support Email</span>
                        <span>SELLORA · {ownerSummary.designatedOwnerEmail || 'olarindevictor3@gmail.com'}</span>
                      </div>
                      <div className="rounded-lg bg-white border border-slate-200 p-2.5">
                        <span className="text-slate-400 block font-sans">App Logo File (Upload in Google Cloud)</span>
                        <span>{origin}/pwa-512x512.png</span>
                      </div>
                      <div className="rounded-lg bg-white border border-slate-200 p-2.5">
                        <span className="text-slate-400 block font-sans">Homepage URL</span>
                        <span>{origin}/</span>
                      </div>
                      <div className="rounded-lg bg-white border border-slate-200 p-2.5">
                        <span className="text-slate-400 block font-sans">Privacy Policy & Terms URLs</span>
                        <span>{origin}/privacy-policy · {origin}/terms</span>
                      </div>
                      <div className="rounded-lg bg-white border border-slate-200 p-2.5">
                        <span className="text-slate-400 block font-sans">Authorized JavaScript Origin</span>
                        <span>{origin}</span>
                      </div>
                      <div className="rounded-lg bg-white border border-slate-200 p-2.5">
                        <span className="text-slate-400 block font-sans">Authorized Redirect URI (Better Auth)</span>
                        <span>{origin}/api/auth/callback/google</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* I. Appearance & Content */}
          {section === 'appearance' && renderAppearanceSection()}
        </div>
      )}
    </div>
  );
};
