import React, { useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  CreditCard,
  LayoutTemplate,
  Mail,
  MapPin,
  Package,
  Settings,
  ShoppingBag,
  Store,
  Tag,
  Users,
} from 'lucide-react';
import { SelloraLogo } from '../SelloraLogo';
import { AdminAnalyticsTab } from './AdminAnalyticsTab';
import { AdminOrdersTab } from './AdminOrdersTab';
import { AdminPaymentsTab } from './AdminPaymentsTab';
import { AdminCatalogTab } from './AdminCatalogTab';
import { AdminOperationsTab } from './AdminOperationsTab';
import { AdminSettingsTab } from './AdminSettingsTab';
import type { Permission } from '../../shared/types';

interface AdminDashboardProps {
  user: any;
  capabilities: any;
  onExitAdmin: () => void;
  onRefreshStorefront: () => Promise<void>;
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
  capabilities,
  onExitAdmin,
  onRefreshStorefront,
}) => {
  const [activeTab, setActiveTab] = useState<AdminTabId>('orders');

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
    { id: 'email', label: 'Email & History', icon: Mail, perm: 'email:manage' },
    { id: 'settings', label: 'Settings & Staff', icon: Settings, perm: 'settings:write' },
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
          {currentTab === 'products' && <AdminCatalogTab key="prod" initialSubTab="products" />}
          {currentTab === 'inventory' && <AdminCatalogTab key="inv" initialSubTab="inventory" />}
          {currentTab === 'customers' && <AdminOperationsTab key="cust" mode="customers" />}
          {currentTab === 'delivery' && <AdminOperationsTab key="del" mode="delivery" />}
          {currentTab === 'marketing' && <AdminOperationsTab key="mkt" mode="marketing" />}
          {currentTab === 'pos' && <AdminOperationsTab key="pos" mode="pos" />}
          {currentTab === 'theme' && (
            <AdminSettingsTab
              key="theme"
              mode="theme"
              capabilities={capabilities}
              onRefreshStorefront={onRefreshStorefront}
            />
          )}
          {currentTab === 'email' && (
            <AdminSettingsTab
              key="email"
              mode="email"
              capabilities={capabilities}
              onRefreshStorefront={onRefreshStorefront}
            />
          )}
          {currentTab === 'settings' && (
            <AdminSettingsTab
              key="settings"
              mode="settings"
              capabilities={capabilities}
              onRefreshStorefront={onRefreshStorefront}
            />
          )}
        </main>
      </div>
    </div>
  );
};
