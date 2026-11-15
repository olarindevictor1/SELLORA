import React, { useEffect, useState } from 'react';
import { AlertCircle, Download, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { formatNgn, ORDER_STATUS_LABELS, type OrderStatus } from '../../shared/types';
import {
  InteractiveDonutChart,
  ProductPerformanceBarChart,
  SalesTrendLineChart,
  type DonutDatum,
} from './AnalyticsCharts';

const TRAFFIC_CATEGORIES: Array<{ label: string; color: string }> = [
  { label: 'Organic Search', color: '#172554' },
  { label: 'Direct', color: '#16A34A' },
  { label: 'Social', color: '#0EA5E9' },
  { label: 'Referral', color: '#F59E0B' },
  { label: 'Other', color: '#64748B' },
];

const DEVICE_PALETTE: Record<string, { label: string; color: string }> = {
  mobile: { label: 'Mobile', color: '#172554' },
  desktop: { label: 'Desktop', color: '#16A34A' },
  tablet: { label: 'Tablet', color: '#0EA5E9' },
};

const CORE_ORDER_STATUS_CHART: Array<{ status: OrderStatus; color: string }> = [
  { status: 'pending_payment', color: '#94A3B8' },
  { status: 'payment_under_review', color: '#F59E0B' },
  { status: 'payment_confirmed', color: '#16A34A' },
  { status: 'processing', color: '#2563EB' },
  { status: 'ready_for_dispatch', color: '#0EA5E9' },
  { status: 'out_for_delivery', color: '#7C3AED' },
  { status: 'delivered', color: '#172554' },
  { status: 'cancelled', color: '#EF4444' },
  { status: 'refunded', color: '#9A2E1E' },
];

const PAYMENT_METHOD_PALETTE: Record<string, { label: string; color: string }> = {
  bank_transfer: { label: 'Bank Transfer (Manual)', color: '#172554' },
  pos_manual: { label: 'In-Store POS', color: '#16A34A' },
  card: { label: 'Card', color: '#0EA5E9' },
};

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export const AdminAnalyticsTab: React.FC = () => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState<'all' | '7d' | '30d' | '90d' | 'custom'>('all');
  const [data, setData] = useState<any>(null);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expError, setExpError] = useState<string | null>(null);

  const [expTitle, setExpTitle] = useState('');
  const [expCategory, setExpCategory] = useState('Operations');
  const [expAmount, setExpAmount] = useState('');
  const [expDate, setExpDate] = useState(new Date().toISOString().slice(0, 10));

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const [an, exp] = await Promise.all([
        apiFetch(`/api/admin/analytics?${qs.toString()}`),
        apiFetch<{ expenses: any[] }>('/api/admin/expenses'),
      ]);
      setData(an);
      setExpenses(exp.expenses || []);
    } catch (e: any) {
      setError(e?.message || 'Unable to load store analytics right now.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [from, to]);

  const applyPreset = (next: 'all' | '7d' | '30d' | '90d') => {
    setPreset(next);
    const today = new Date().toISOString().slice(0, 10);
    if (next === 'all') {
      setFrom('');
      setTo('');
    } else if (next === '7d') {
      setFrom(isoDaysAgo(6));
      setTo(today);
    } else if (next === '30d') {
      setFrom(isoDaysAgo(29));
      setTo(today);
    } else {
      setFrom(isoDaysAgo(89));
      setTo(today);
    }
  };

  const addExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setExpError(null);
    try {
      await apiFetch('/api/admin/expenses', {
        method: 'POST',
        body: JSON.stringify({
          title: expTitle,
          category: expCategory,
          amountNaira: Number(expAmount),
          incurredAt: expDate,
        }),
      });
      setExpTitle('');
      setExpAmount('');
      await load();
    } catch (err: any) {
      setExpError(err?.message || 'Failed to record expense.');
    }
  };

  const deleteExpense = async (id: string) => {
    setExpError(null);
    try {
      await apiFetch(`/api/admin/expenses/${id}`, { method: 'DELETE' });
      await load();
    } catch (err: any) {
      setExpError(err?.message || 'Failed to remove expense.');
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-white border border-slate-200 animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-56 rounded-xl bg-white border border-slate-200 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const m = data?.metrics || {};
  const inv = data?.inventory || {};
  const cust = data?.customers || {};
  const insights = data?.insights || {};

  // A. Traffic source donut data
  const catMap = new Map<string, number>(
    (insights.trafficSourceCategories || []).map((c: any) => [String(c.category), Number(c.visitors || 0)])
  );
  const trafficDonutData: DonutDatum[] = TRAFFIC_CATEGORIES.map((tc) => ({
    key: tc.label,
    label: tc.label,
    value: catMap.get(tc.label) || 0,
    color: tc.color,
  }));

  // B. Device category donut data
  const devMap = new Map<string, number>(
    (insights.deviceCategories || []).map((d: any) => [String(d.device || '').toLowerCase(), Number(d.visitors || 0)])
  );
  const deviceDonutData: DonutDatum[] = ['mobile', 'desktop', 'tablet'].map((devKey) => ({
    key: devKey,
    label: DEVICE_PALETTE[devKey].label,
    value: devMap.get(devKey) || 0,
    color: DEVICE_PALETTE[devKey].color,
  }));
  for (const [k, v] of devMap.entries()) {
    if (!DEVICE_PALETTE[k] && v > 0) {
      deviceDonutData.push({
        key: k,
        label: k.charAt(0).toUpperCase() + k.slice(1),
        value: v,
        color: '#64748B',
      });
    }
  }

  // C. Order status donut data (9 core order statuses + any optional states if > 0)
  const orderStatusMap = new Map<string, number>(
    (data?.orderStatusBreakdown || []).map((r: any) => [String(r.status), Number(r.count || 0)])
  );
  const orderStatusDonutData: DonutDatum[] = CORE_ORDER_STATUS_CHART.map((cfg) => ({
    key: cfg.status,
    label: ORDER_STATUS_LABELS[cfg.status],
    value: orderStatusMap.get(cfg.status) || 0,
    color: cfg.color,
  }));
  for (const [status, count] of orderStatusMap.entries()) {
    if (!CORE_ORDER_STATUS_CHART.some((c) => c.status === status) && count > 0) {
      orderStatusDonutData.push({
        key: status,
        label: ORDER_STATUS_LABELS[status as OrderStatus] || status.replace(/_/g, ' '),
        value: count,
        color: '#64748B',
      });
    }
  }

  // D. Payment method donut data
  const fallbackPalette = ['#0EA5E9', '#7C3AED', '#F59E0B', '#64748B'];
  const paymentMethodDonutData: DonutDatum[] = (data?.paymentMethodBreakdown || []).map(
    (pm: any, idx: number) => {
      const key = String(pm.method || 'other');
      const presetInfo = PAYMENT_METHOD_PALETTE[key];
      return {
        key,
        label: presetInfo?.label || key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
        value: Number(pm.count || 0),
        color: presetInfo?.color || fallbackPalette[idx % fallbackPalette.length],
      };
    }
  );

  // Funnel stages with step retention safety
  const funnelSteps = [
    { label: 'Unique Visitors', val: Number(insights.uniqueVisitors ?? 0) },
    { label: 'Page Views', val: Number(insights.pageViews ?? 0) },
    { label: 'Product Views', val: Number(insights.productViews ?? 0) },
    { label: 'Add to Bag', val: Number(insights.addToCart ?? 0) },
    { label: 'Begin Checkout', val: Number(insights.beginCheckout ?? 0) },
    { label: 'Confirmed Orders', val: Number(insights.confirmedPurchases ?? 0) },
  ];

  return (
    <div className="space-y-6">
      {/* Header & Date Range Filters */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#172554]">Analytics & Financial Overview</h2>
          <p className="text-xs text-slate-500">
            All metrics reflect verified D1/SQLite database records. Unverified receipts are separated from confirmed revenue.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-lg">
            {(
              [
                { id: 'all', label: 'All Time' },
                { id: '7d', label: '7D' },
                { id: '30d', label: '30D' },
                { id: '90d', label: '90D' },
              ] as const
            ).map((btn) => (
              <button
                key={btn.id}
                type="button"
                onClick={() => applyPreset(btn.id)}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                  preset === btn.id
                    ? 'bg-[#172554] text-[#B7F36B]'
                    : 'text-slate-600 hover:text-[#172554]'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>

          <input
            type="date"
            value={from}
            onChange={(e) => {
              setPreset('custom');
              setFrom(e.target.value);
            }}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
            aria-label="From date"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setPreset('custom');
              setTo(e.target.value);
            }}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
            aria-label="To date"
          />
          <a
            href="/api/admin/orders/export"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#172554] hover:bg-slate-50"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </a>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-[#F47B68]/15 border border-[#F47B68]/40 px-4 py-3 flex items-center justify-between gap-4 text-xs text-[#9A2E1E]">
          <div className="flex items-center gap-2 font-semibold">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1 rounded-lg bg-white border border-[#F47B68]/40 px-3 py-1 font-semibold text-[#9A2E1E] hover:bg-slate-50 shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      )}

      {/* Primary Financial KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl bg-white border border-slate-200 p-5">
          <div className="text-xs text-slate-500">Confirmed Revenue</div>
          <div className="text-2xl font-bold text-[#172554] tabular-nums mt-1">
            {formatNgn(m.confirmedRevenueKobo)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
            Pending Verification: {formatNgn(m.unconfirmedRevenueKobo)}
          </div>
        </div>

        <div className="rounded-xl bg-white border border-slate-200 p-5">
          <div className="text-xs text-slate-500">Orders & Avg Order Value</div>
          <div className="text-2xl font-bold text-[#172554] tabular-nums mt-1">
            {m.totalOrders ?? 0}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
            AOV: {m.averageOrderValueKobo !== null && m.averageOrderValueKobo !== undefined ? formatNgn(m.averageOrderValueKobo) : 'Unavailable (0 orders)'}
          </div>
        </div>

        <div className="rounded-xl bg-white border border-slate-200 p-5">
          <div className="text-xs text-slate-500">Net Profit (Confirmed − COGS − Expenses)</div>
          <div className="text-2xl font-bold text-[#172554] tabular-nums mt-1">
            {m.netProfitKobo !== null && m.netProfitKobo !== undefined
              ? formatNgn(m.netProfitKobo)
              : 'Unavailable'}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">{m.profitAvailabilityNote}</div>
        </div>

        <div className="rounded-xl bg-white border border-slate-200 p-5">
          <div className="text-xs text-slate-500">Inventory Valuation (Retail)</div>
          <div className="text-2xl font-bold text-[#172554] tabular-nums mt-1">
            {formatNgn(inv.retailValueKobo)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
            {inv.totalUnits ?? 0} units · {inv.lowStockCount ?? 0} low · {inv.outOfStockCount ?? 0} out
          </div>
        </div>
      </div>

      {/* Secondary Financial Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs">
        <div className="rounded-xl bg-white border border-slate-200 p-4 flex justify-between">
          <span className="text-slate-500">Gross Non-Cancelled Sales</span>
          <strong className="tabular-nums text-[#172554]">{formatNgn(m.grossSalesKobo)}</strong>
        </div>
        <div className="rounded-xl bg-white border border-slate-200 p-4 flex justify-between">
          <span className="text-slate-500">Discounts Given</span>
          <strong className="tabular-nums text-[#172554]">{formatNgn(m.discountsKobo)}</strong>
        </div>
        <div className="rounded-xl bg-white border border-slate-200 p-4 flex justify-between">
          <span className="text-slate-500">Refunds Issued</span>
          <strong className="tabular-nums text-[#9A2E1E]">{formatNgn(m.refundedKobo)}</strong>
        </div>
        <div className="rounded-xl bg-white border border-slate-200 p-4 flex justify-between">
          <span className="text-slate-500">Ordering / Repeat Customers</span>
          <strong className="tabular-nums text-[#172554]">
            {cust.totalOrderingCustomers ?? 0} / {cust.repeatCustomers ?? 0}
          </strong>
        </div>
      </div>

      {/* Sales Trend Line Chart */}
      <SalesTrendLineChart
        daily={data?.salesTrendDaily || []}
        weekly={data?.salesTrendWeekly || []}
        monthly={data?.salesTrendMonthly || []}
      />

      {/* Interactive Donut Charts Grid (A, B, C, D) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <InteractiveDonutChart
          title="Traffic Sources"
          subtitle="First-party storefront visitor attribution by referrer channel."
          data={trafficDonutData}
          centerLabel="Visitors"
          valueFormatter={(v) => v.toLocaleString()}
          emptyTitle="No storefront traffic logged yet"
          emptyDescription="Source breakdown (Organic Search, Direct, Social, Referral, Other) populates as real visitors browse the store."
        />

        <InteractiveDonutChart
          title="Device Categories"
          subtitle="Unique visitor breakdown across Mobile, Desktop, and Tablet."
          data={deviceDonutData}
          centerLabel="Visitors"
          valueFormatter={(v) => v.toLocaleString()}
          emptyTitle="No device telemetry yet"
          emptyDescription="Device categories populate automatically as customers visit public pages."
        />

        <InteractiveDonutChart
          title="Order Status Breakdown"
          subtitle="Live distribution across payment review, fulfilment, delivery, cancellations, and refunds."
          data={orderStatusDonutData}
          centerLabel="Orders"
          valueFormatter={(v) => v.toLocaleString()}
          emptyTitle="No orders in selected range"
          emptyDescription="Order counts across all workflow statuses appear here once orders are placed."
        />

        <InteractiveDonutChart
          title="Payment Methods"
          subtitle="Breakdown by recorded payment channel."
          data={paymentMethodDonutData}
          centerLabel="Payments"
          valueFormatter={(v) => v.toLocaleString()}
          emptyTitle="No payments recorded in range"
          emptyDescription="Manual bank transfer and POS payment counts appear here once checkout records exist."
        />
      </div>

      {/* Product Performance Bar Chart & Landing Pages */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <ProductPerformanceBarChart items={data?.bestsellers || []} />
        </div>

        <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-3">
          <div>
            <h3 className="text-sm font-bold text-[#172554]">Top Landing Pages</h3>
            <p className="text-[11px] text-slate-500">Most viewed storefront entry routes.</p>
          </div>
          {insights.landingPages?.length ? (
            <div className="divide-y divide-slate-100 text-xs">
              {insights.landingPages.map((p: any) => (
                <div key={p.path} className="py-2 flex justify-between items-center gap-2">
                  <span className="font-mono-tabular text-[#1E293B] truncate">{p.path}</span>
                  <span className="font-semibold text-[#172554] tabular-nums shrink-0">
                    {p.views} views
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">No page views logged in range.</p>
          )}

          {insights.trafficSources?.length > 0 && (
            <div className="pt-3 border-t border-slate-100">
              <div className="text-xs font-bold text-[#172554] mb-1.5">Raw Referrer Hosts</div>
              <div className="space-y-1 text-xs">
                {insights.trafficSources.slice(0, 5).map((s: any) => (
                  <div key={s.source} className="flex justify-between text-slate-600">
                    <span className="truncate">{s.source}</span>
                    <span className="font-semibold tabular-nums">{s.visitors}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Conversion Funnel */}
      <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-[#172554]">Storefront Conversion Funnel</h3>
            <p className="text-xs text-slate-500">
              First-party non-PII funnel events in D1 alongside GA4 telemetry. External GA4 queries require Google Analytics Data API.
            </p>
          </div>
          <span className="text-xs font-bold text-[#172554] tabular-nums">
            Confirmed Conversion Rate:{' '}
            {insights.conversionRatePct !== null && insights.conversionRatePct !== undefined
              ? `${insights.conversionRatePct}%`
              : 'Insufficient visits'}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
          {funnelSteps.map((stat, idx) => {
            const prevVal = idx > 0 ? funnelSteps[idx - 1].val : 0;
            const stepPct =
              idx > 0 && prevVal > 0 ? `${Math.min(100, Math.round((stat.val / prevVal) * 100))}% of prev` : null;
            return (
              <div
                key={stat.label}
                className="rounded-lg bg-[#F5F7F4] border border-slate-200 p-3 flex flex-col justify-between"
              >
                <div className="text-slate-500 text-[11px]">{stat.label}</div>
                <div className="text-lg font-bold text-[#172554] tabular-nums mt-0.5">{stat.val}</div>
                <div className="text-[10px] text-slate-400 tabular-nums mt-0.5">
                  {stepPct || (idx === 0 ? 'Top of funnel' : '—')}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Slow Movers + Recorded Store Expenses */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-3">
          <h3 className="text-sm font-bold text-[#172554]">Slow-Moving Active Catalog</h3>
          {data?.slowMovers?.length ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-2">Product</th>
                  <th className="py-2 text-right">Confirmed Units</th>
                  <th className="py-2 text-right">On Hand</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.slowMovers.map((s: any) => (
                  <tr key={s.id}>
                    <td className="py-2 font-medium text-[#1E293B]">{s.name}</td>
                    <td className="py-2 text-right tabular-nums">{s.units_sold}</td>
                    <td className="py-2 text-right tabular-nums">{s.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-slate-500">No active products.</p>
          )}
        </div>

        {/* Recorded Expenses (for honest Net Profit) */}
        <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-[#172554]">Recorded Store Expenses</h3>
              <p className="text-xs text-slate-500">
                Used together with item cost prices to compute verified net profit.
              </p>
            </div>
            <span className="text-xs font-bold text-[#172554] tabular-nums">
              Total: {formatNgn(m.expensesKobo)}
            </span>
          </div>

          {expError && (
            <div className="rounded-lg bg-[#F47B68]/15 px-3 py-2 text-xs font-semibold text-[#9A2E1E]">
              {expError}
            </div>
          )}

          <form onSubmit={addExpense} className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              type="text"
              required
              value={expTitle}
              onChange={(e) => setExpTitle(e.target.value)}
              placeholder="Expense title (e.g. Packaging)"
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
            />
            <input
              type="text"
              required
              value={expCategory}
              onChange={(e) => setExpCategory(e.target.value)}
              placeholder="Category"
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
            />
            <input
              type="number"
              step="0.01"
              required
              value={expAmount}
              onChange={(e) => setExpAmount(e.target.value)}
              placeholder="Amount (NGN)"
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
            />
            <div className="flex gap-2">
              <input
                type="date"
                required
                value={expDate}
                onChange={(e) => setExpDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-2 py-2 text-xs"
              />
              <button
                type="submit"
                className="rounded-lg bg-[#172554] px-3 py-2 text-xs font-bold text-[#B7F36B] shrink-0"
                aria-label="Add expense"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </form>

          {expenses.length > 0 && (
            <div className="divide-y divide-slate-100 text-xs max-h-48 overflow-y-auto">
              {expenses.map((ex) => (
                <div key={ex.id} className="py-2 flex items-center justify-between gap-4">
                  <div>
                    <span className="font-semibold text-[#1E293B]">{ex.title}</span>
                    <span className="text-slate-500 ml-2">
                      {ex.category} · {ex.incurred_at}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-bold tabular-nums text-[#172554]">
                      {formatNgn(ex.amount_kobo)}
                    </span>
                    <button
                      type="button"
                      onClick={() => deleteExpense(ex.id)}
                      className="text-slate-400 hover:text-[#F47B68]"
                      aria-label={`Delete ${ex.title}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
