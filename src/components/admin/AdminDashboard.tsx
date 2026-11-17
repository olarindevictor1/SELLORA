import React, { useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Copy,
  CreditCard,
  KeyRound,
  LayoutTemplate,
  Lock,
  LogOut,
  Mail,
  MapPin,
  Package,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Store,
  Tag,
  Users,
} from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { SelloraLogo } from '../SelloraLogo';
import { AdminAnalyticsTab } from './AdminAnalyticsTab';
import { AdminOrdersTab } from './AdminOrdersTab';
import { AdminPaymentsTab } from './AdminPaymentsTab';
import { AdminCatalogTab } from './AdminCatalogTab';
import { AdminOperationsTab } from './AdminOperationsTab';
import { AdminSettingsTab } from './AdminSettingsTab';
import { formatLagosDate, type AdminSecurityStatus, type Permission } from '../../shared/types';

interface AdminDashboardProps {
  user: any;
  adminSecurity?: AdminSecurityStatus | null;
  capabilities: any;
  onExitAdmin: () => void;
  onRefreshStorefront: () => Promise<void>;
  onRefreshSession: () => Promise<void>;
}

type AdminTabId =
  | 'analytics'
  | 'orders'
  | 'payments'
  | 'products'
  | 'inventory'
  | 'customers'
  | 'delivery'
  | 'marketing'
  | 'pos'
  | 'theme'
  | 'email'
  | 'settings';

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  user,
  adminSecurity,
  capabilities,
  onExitAdmin,
  onRefreshStorefront,
  onRefreshSession,
}) => {
  const [activeTab, setActiveTab] = useState<AdminTabId>('orders');

  // Strict security gate state
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [gateInfo, setGateInfo] = useState<string | null>(null);

  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirm, setSetupConfirm] = useState('');
  const [createdRecoveryCode, setCreatedRecoveryCode] = useState<string | null>(null);

  const [verifyPassword, setVerifyPassword] = useState('');
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryTokenOrCode, setRecoveryTokenOrCode] = useState('');
  const [recoveryNewPassword, setRecoveryNewPassword] = useState('');

  const signOutAdmin = async () => {
    setGateBusy(true);
    try {
      await apiFetch('/api/auth/sign-out', { method: 'POST' });
    } catch {
      // ignore
    } finally {
      await onRefreshSession();
      setGateBusy(false);
    }
  };

  const handleRefreshLock = async () => {
    setGateBusy(true);
    setGateError(null);
    setGateInfo(null);
    try {
      await onRefreshSession();
    } catch (e: any) {
      setGateError(e.message);
    } finally {
      setGateBusy(false);
    }
  };

  const handleSetupPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setGateError(null);
    setGateInfo(null);
    if (setupPassword !== setupConfirm) {
      setGateError('Admin Security Passwords do not match.');
      return;
    }
    setGateBusy(true);
    try {
      const res = await apiFetch<{ recoveryCode?: string }>('/api/admin/security/password/setup', {
        method: 'POST',
        body: JSON.stringify({ newPassword: setupPassword }),
      });
      setSetupPassword('');
      setSetupConfirm('');
      if (res.recoveryCode) {
        setCreatedRecoveryCode(res.recoveryCode);
        setGateInfo('Admin Security Password configured. Save your one-time backup recovery code now before entering.');
      } else {
        await onRefreshSession();
      }
    } catch (e: any) {
      setGateError(e.message);
    } finally {
      setGateBusy(false);
    }
  };

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setGateError(null);
    setGateInfo(null);
    setGateBusy(true);
    try {
      await apiFetch('/api/admin/security/password/verify', {
        method: 'POST',
        body: JSON.stringify({ password: verifyPassword }),
      });
      setVerifyPassword('');
      await onRefreshSession();
    } catch (e: any) {
      setGateError(e.message);
      await onRefreshSession();
    } finally {
      setGateBusy(false);
    }
  };

  const handleRequestEmailRecovery = async () => {
    setGateError(null);
    setGateInfo(null);
    setGateBusy(true);
    try {
      const res = await apiFetch<{ message?: string }>('/api/admin/security/password/recover/request', {
        method: 'POST',
      });
      setGateInfo(res.message || 'Recovery token queued to your registered administrator email.');
    } catch (e: any) {
      setGateError(e.message);
    } finally {
      setGateBusy(false);
    }
  };

  const handleConfirmRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setGateError(null);
    setGateInfo(null);
    setGateBusy(true);
    try {
      const res = await apiFetch<{ recoveryCode?: string }>(
        '/api/admin/security/password/recover/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            recoveryTokenOrCode,
            newPassword: recoveryNewPassword,
          }),
        }
      );
      setRecoveryTokenOrCode('');
      setRecoveryNewPassword('');
      setShowRecovery(false);
      if (res.recoveryCode) {
        setCreatedRecoveryCode(res.recoveryCode);
        setGateInfo('Admin Security Password reset. Save your new backup recovery code below.');
      } else {
        await onRefreshSession();
      }
    } catch (e: any) {
      setGateError(e.message);
    } finally {
      setGateBusy(false);
    }
  };

  // Enforce strict pre-dashboard gate whenever session is not yet unlocked
  if (createdRecoveryCode || (adminSecurity?.required && !adminSecurity?.unlocked)) {
    const lockCode = adminSecurity?.lockCode;
    const isRejected = adminSecurity?.deviceApprovalStatus === 'rejected';
    const isExpired = adminSecurity?.deviceApprovalStatus === 'expired';
    const reasonLabel =
      adminSecurity?.triggerReason === 'unfamiliar_device_and_ip'
        ? 'Unrecognized Browser / Device and Unrecognized IP Address'
        : adminSecurity?.triggerReason === 'unfamiliar_device'
          ? 'Unrecognized Browser / Device'
          : adminSecurity?.triggerReason === 'unfamiliar_ip'
            ? 'Unrecognized IP Address'
            : 'Strict Device and IP Verification';

    return (
      <div className="min-h-screen bg-[#F5F7F4] flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-lg w-full rounded-2xl bg-white border border-slate-200 shadow-lg p-6 sm:p-8 space-y-5 text-xs">
          <div className="flex items-center justify-between gap-4">
            <SelloraLogo size="md" />
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-[#172554]/10 px-2.5 py-1 text-[11px] font-bold text-[#172554]">
              <Lock className="w-3.5 h-3.5" /> Admin Security Gate
            </span>
          </div>

          {gateInfo && (
            <div className="rounded-lg bg-[#B7F36B]/30 border border-[#172554]/20 px-4 py-2.5 font-semibold text-[#172554]">
              {gateInfo}
            </div>
          )}
          {gateError && (
            <div className="rounded-lg bg-[#F47B68]/15 border border-[#F47B68]/40 px-4 py-2.5 font-semibold text-[#9A2E1E]">
              {gateError}
            </div>
          )}

          {createdRecoveryCode ? (
            <div className="space-y-4">
              <div className="inline-flex items-center gap-1.5 font-bold text-sm text-[#172554]">
                <ShieldCheck className="w-4 h-4 text-emerald-600" /> Save Your Backup Recovery Code
              </div>
              <p className="text-slate-600 leading-relaxed">
                Store this single-use backup recovery code in a password manager. It will not be displayed
                again and can reset your Admin Security Password if needed.
              </p>
              <div className="flex items-center gap-2 rounded-xl bg-[#F5F7F4] border border-slate-200 px-4 py-3 font-mono-tabular text-sm font-bold text-[#172554]">
                <span className="flex-1 select-all">{createdRecoveryCode}</span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(createdRecoveryCode)}
                  className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-sans font-semibold text-[#172554]"
                >
                  <Copy className="w-3 h-3" /> Copy
                </button>
              </div>
              <button
                type="button"
                onClick={async () => {
                  setCreatedRecoveryCode(null);
                  await onRefreshSession();
                }}
                className="w-full rounded-xl bg-[#172554] px-4 py-3 text-xs font-bold text-[#B7F36B]"
              >
                Continue to Admin Console
              </button>
            </div>
          ) : lockCode === 'ADMIN_SECURITY_LOCKED' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-base font-bold text-[#172554]">
                <ShieldAlert className="w-5 h-5 text-[#9A2E1E]" />
                <span>
                  {isRejected
                    ? 'Access Request Rejected'
                    : isExpired
                      ? 'Approval Request Expired'
                      : 'Gmail Approval Required'}
                </span>
              </div>
              <p className="text-slate-600 leading-relaxed">
                {isRejected
                  ? 'This administrative login session was rejected. Sign out and sign in again from an authorized device.'
                  : isExpired
                    ? 'The 20-minute security approval window expired for this login session. Sign out and sign in again to send a new approval request.'
                    : 'This sign-in comes from an unrecognized device or IP address. Dashboard access is locked for this session until you open the security alert in your administrator Gmail inbox and confirm YES — APPROVE ACCESS.'}
              </p>

              <div className="rounded-xl bg-[#F5F7F4] border border-slate-200 p-4 space-y-2">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Account</span>
                  <strong className="text-[#172554]">{user.email}</strong>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Policy Check</span>
                  <strong className="text-[#172554] text-right">{reasonLabel}</strong>
                </div>
                {adminSecurity?.currentDeviceSummary && (
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Client Device</span>
                    <strong className="text-[#172554] text-right">{adminSecurity.currentDeviceSummary}</strong>
                  </div>
                )}
                {adminSecurity?.currentIp && (
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Client IP</span>
                    <strong className="font-mono-tabular text-[#172554]">{adminSecurity.currentIp}</strong>
                  </div>
                )}
                {adminSecurity?.approvalExpiresAt && !isExpired && !isRejected && (
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Link Expires</span>
                    <strong className="text-[#172554]">{formatLagosDate(adminSecurity.approvalExpiresAt)}</strong>
                  </div>
                )}
              </div>

              <div className="flex flex-col sm:flex-row gap-2 pt-1">
                {!isExpired && !isRejected && (
                  <button
                    type="button"
                    disabled={gateBusy}
                    onClick={handleRefreshLock}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#172554] px-4 py-2.5 font-bold text-[#B7F36B] disabled:opacity-60"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Check Approval Status
                  </button>
                )}
                <button
                  type="button"
                  disabled={gateBusy}
                  onClick={signOutAdmin}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 px-4 py-2.5 font-semibold text-[#172554] hover:bg-slate-50"
                >
                  <LogOut className="w-3.5 h-3.5" /> {isExpired || isRejected ? 'Sign In Fresh' : 'Sign Out'}
                </button>
              </div>
            </div>
          ) : lockCode === 'ADMIN_SEC_PASSWORD_SETUP_REQUIRED' ? (
            <form onSubmit={handleSetupPassword} className="space-y-4">
              <div className="flex items-center gap-2 text-base font-bold text-[#172554]">
                <KeyRound className="w-5 h-5 text-[#172554]" />
                <span>Set Your Admin Security Password</span>
              </div>
              <p className="text-slate-600 leading-relaxed">
                SELLORA requires a separate Admin Security Password after login authentication before entering
                store operations. Choose a strong passphrase distinct from your login password.
              </p>
              <div>
                <label className="block font-semibold text-[#172554] mb-1">
                  New Admin Security Password (min. 8 characters) *
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={setupPassword}
                  onChange={(e) => setSetupPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#172554] mb-1">
                  Confirm Admin Security Password *
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={setupConfirm}
                  onChange={(e) => setSetupConfirm(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>
              <button
                type="submit"
                disabled={gateBusy}
                className="w-full rounded-xl bg-[#172554] px-4 py-2.5 font-bold text-[#B7F36B] disabled:opacity-60"
              >
                {gateBusy ? 'Saving...' : 'Save Security Password & Generate Backup Code'}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-base font-bold text-[#172554]">
                <KeyRound className="w-5 h-5 text-[#172554]" />
                <span>Verify Admin Security Password</span>
              </div>
              <p className="text-slate-600 leading-relaxed">
                Device verified for <strong>{user.email}</strong>. Enter your separate Admin Security
                Password to unlock the console for this session.
              </p>

              {adminSecurity && adminSecurity.secondaryPasswordRetryAfterSec ? (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-amber-900 font-semibold">
                  Verification temporarily paused. Try again in approximately{' '}
                  {Math.ceil(adminSecurity.secondaryPasswordRetryAfterSec / 60)} minute(s).
                </div>
              ) : null}

              {!showRecovery ? (
                <form onSubmit={handleVerifyPassword} className="space-y-3">
                  <div>
                    <label className="block font-semibold text-[#172554] mb-1">
                      Admin Security Password
                    </label>
                    <input
                      type="password"
                      required
                      autoFocus
                      value={verifyPassword}
                      onChange={(e) => setVerifyPassword(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setShowRecovery(true)}
                      className="text-[#172554] underline font-semibold"
                    >
                      Forgot security password?
                    </button>
                    <button
                      type="button"
                      onClick={onExitAdmin}
                      className="text-slate-500 hover:text-[#172554]"
                    >
                      Return to Storefront
                    </button>
                  </div>
                  <button
                    type="submit"
                    disabled={gateBusy}
                    className="w-full rounded-xl bg-[#172554] px-4 py-2.5 font-bold text-[#B7F36B] disabled:opacity-60"
                  >
                    {gateBusy ? 'Verifying...' : 'Unlock Admin Console'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleConfirmRecovery} className="space-y-3 border-t border-slate-200 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-[#172554]">Reset Admin Security Password</span>
                    <button
                      type="button"
                      onClick={() => setShowRecovery(false)}
                      className="text-slate-500 underline"
                    >
                      Back to password unlock
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={gateBusy}
                    onClick={handleRequestEmailRecovery}
                    className="w-full rounded-lg border border-[#172554] px-3 py-2 font-semibold text-[#172554] hover:bg-[#F5F7F4]"
                  >
                    Email One-Time Recovery Token to Admin Inbox
                  </button>
                  <div>
                    <label className="block font-semibold text-[#172554] mb-1">
                      Recovery Token or Backup Recovery Code
                    </label>
                    <input
                      type="text"
                      required
                      value={recoveryTokenOrCode}
                      onChange={(e) => setRecoveryTokenOrCode(e.target.value)}
                      placeholder="SLR-REC-... or emailed token"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono-tabular"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-[#172554] mb-1">
                      New Admin Security Password *
                    </label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={recoveryNewPassword}
                      onChange={(e) => setRecoveryNewPassword(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={gateBusy}
                    className="w-full rounded-xl bg-[#172554] px-4 py-2.5 font-bold text-[#B7F36B] disabled:opacity-60"
                  >
                    Reset & Unlock Admin Console
                  </button>
                </form>
              )}
            </div>
          )}

          <div className="pt-2 border-t border-slate-100 flex justify-between items-center text-[11px] text-slate-400">
            <span>Session Protected · SELLORA Security</span>
            <button type="button" onClick={onExitAdmin} className="hover:text-[#172554]">
              Storefront
            </button>
          </div>
        </div>
      </div>
    );
  }

  const perms = new Set<Permission>(user?.permissions || []);
  const allNavItems: Array<{
    id: AdminTabId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    perm?: Permission;
  }> = [
    { id: 'analytics', label: 'Analytics', icon: BarChart3, perm: 'analytics:read' },
    { id: 'orders', label: 'Orders', icon: ShoppingBag, perm: 'orders:read' },
    { id: 'payments', label: 'Payment Review', icon: CreditCard, perm: 'payments:review' },
    { id: 'products', label: 'Products', icon: Package, perm: 'products:read' },
    { id: 'inventory', label: 'Inventory', icon: Package, perm: 'products:read' },
    { id: 'customers', label: 'Customers', icon: Users, perm: 'customers:read' },
    { id: 'delivery', label: 'Delivery Zones', icon: MapPin, perm: 'delivery:write' },
    { id: 'marketing', label: 'Marketing', icon: Tag, perm: 'marketing:write' },
    { id: 'pos', label: 'Point of Sale', icon: Store, perm: 'pos:use' },
    { id: 'theme', label: 'Theme & CMS', icon: LayoutTemplate, perm: 'settings:write' },
    { id: 'email', label: 'Order Notifications', icon: Mail, perm: 'email:manage' },
    { id: 'settings', label: 'Settings & Staff', icon: Settings },
  ];
  const navItems = allNavItems.filter((item) => !item.perm || perms.has(item.perm));

  const currentTab = navItems.some((n) => n.id === activeTab)
    ? activeTab
    : navItems[0]?.id || 'orders';

  const currentLabel = navItems.find((n) => n.id === currentTab)?.label || 'Dashboard';

  return (
    <div className="min-h-screen bg-[#F5F7F4] flex flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="w-full lg:w-[252px] bg-[#172554] text-white shrink-0 flex flex-col no-print">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <SelloraLogo variant="dark" size="sm" />
        </div>

        <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = currentTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`inline-flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-[#B7F36B] text-[#172554]'
                    : 'text-slate-200 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto p-4 border-t border-white/10 hidden lg:block space-y-2 text-xs">
          <div className="font-semibold text-white truncate">{user.name}</div>
          <div className="text-slate-300 truncate">{user.email}</div>
          <button
            type="button"
            onClick={onExitAdmin}
            className="mt-2 inline-flex items-center gap-1.5 text-[#B7F36B] hover:underline font-semibold"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Storefront
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-4 no-print">
          <div className="text-xs text-slate-500">
            <span>SELLORA Console</span>
            <span className="mx-2">/</span>
            <strong className="text-[#172554]">{currentLabel}</strong>
          </div>
          <button
            type="button"
            onClick={onExitAdmin}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-[#172554] hover:bg-[#F5F7F4] whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Storefront
          </button>
        </header>

        <main className="flex-1 p-5 sm:p-8 max-w-7xl w-full mx-auto">
          {currentTab === 'analytics' && <AdminAnalyticsTab />}
          {currentTab === 'orders' && <AdminOrdersTab />}
          {currentTab === 'payments' && <AdminPaymentsTab />}
          {currentTab === 'products' && <AdminCatalogTab key="prod" initialSubTab="products" user={user} />}
          {currentTab === 'inventory' && <AdminCatalogTab key="inv" initialSubTab="inventory" user={user} />}
          {currentTab === 'customers' && <AdminOperationsTab key="cust" mode="customers" />}
          {currentTab === 'delivery' && <AdminOperationsTab key="del" mode="delivery" />}
          {currentTab === 'marketing' && <AdminOperationsTab key="mkt" mode="marketing" />}
          {currentTab === 'pos' && <AdminOperationsTab key="pos" mode="pos" />}
          {currentTab === 'theme' && (
            <AdminSettingsTab
              key="theme"
              mode="theme"
              capabilities={capabilities}
              user={user}
              onRefreshStorefront={onRefreshStorefront}
            />
          )}
          {currentTab === 'email' && (
            <AdminSettingsTab
              key="email"
              mode="email"
              capabilities={capabilities}
              user={user}
              onRefreshStorefront={onRefreshStorefront}
            />
          )}
          {currentTab === 'settings' && (
            <AdminSettingsTab
              key="settings"
              mode="settings"
              capabilities={capabilities}
              user={user}
              onRefreshStorefront={onRefreshStorefront}
            />
          )}
        </main>
      </div>
    </div>
  );
};
