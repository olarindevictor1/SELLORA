import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { formatNgn } from '../../shared/types';
import { NIGERIAN_STATES_LGAS, getLgasForState } from '../../shared/nigeria-locations';

export const AdminOperationsTab: React.FC<{
  mode: 'customers' | 'delivery' | 'marketing' | 'pos';
}> = ({ mode }) => {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Customers & Support
  const [customers, setCustomers] = useState<any[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  const [privacyReqs, setPrivacyReqs] = useState<any[]>([]);
  const [replyMap, setReplyMap] = useState<Record<string, string>>({});

  // Delivery Zones
  const [zones, setZones] = useState<any[]>([]);
  const [zState, setZState] = useState('Lagos');
  const [zLga, setZLga] = useState('*');
  const [zFee, setZFee] = useState('');
  const [zFreeThreshold, setZFreeThreshold] = useState('');
  const [zMinDays, setZMinDays] = useState('1');
  const [zMaxDays, setZMaxDays] = useState('3');
  const [zCourier, setZCourier] = useState('');
  const [zInstructions, setZInstructions] = useState('');

  // Marketing
  const [coupons, setCoupons] = useState<any[]>([]);
  const [subscribers, setSubscribers] = useState<any[]>([]);
  const [cCode, setCCode] = useState('');
  const [cType, setCType] = useState<'percentage' | 'fixed'>('percentage');
  const [cVal, setCVal] = useState('');
  const [cMinSpend, setCMinSpend] = useState('0');

  // POS
  const [products, setProducts] = useState<any[]>([]);
  const [posItems, setPosItems] = useState<Array<{ productId: string; variantId: string; name: string; sku: string; priceKobo: number; quantity: number }>>([]);
  const [posCustomer, setPosCustomer] = useState('Walk-in Customer');
  const [posDiscount, setPosDiscount] = useState('0');
  const [posPaid, setPosPaid] = useState(true);

  const load = async () => {
    setErr(null);
    try {
      if (mode === 'customers') {
        const [cRes, sRes] = await Promise.all([
          apiFetch<{ customers: any[] }>('/api/admin/customers'),
          apiFetch<{ tickets: any[]; privacyRequests: any[] }>('/api/admin/support'),
        ]);
        setCustomers(cRes.customers || []);
        setTickets(sRes.tickets || []);
        setPrivacyReqs(sRes.privacyRequests || []);
      } else if (mode === 'delivery') {
        const dRes = await apiFetch<{ zones: any[] }>('/api/admin/delivery-zones');
        setZones(dRes.zones || []);
      } else if (mode === 'marketing') {
        const mRes = await apiFetch<{ coupons: any[]; subscribers: any[] }>('/api/admin/coupons');
        setCoupons(mRes.coupons || []);
        setSubscribers(mRes.subscribers || []);
      } else if (mode === 'pos') {
        const pRes = await apiFetch<{ products: any[] }>('/api/admin/products');
        setProducts(pRes.products || []);
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
  }, [mode]);

  const addZone = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await apiFetch('/api/admin/delivery-zones', {
        method: 'POST',
        body: JSON.stringify({
          state: zState,
          lga: zLga,
          feeNaira: Number(zFee),
          freeThresholdNaira: zFreeThreshold ? Number(zFreeThreshold) : null,
          estimatedDaysMin: Number(zMinDays),
          estimatedDaysMax: Number(zMaxDays),
          courierName: zCourier,
          instructions: zInstructions,
          isEnabled: true,
        }),
      });
      setZFee('');
      setZFreeThreshold('');
      setMsg(`Delivery zone configured for ${zLga === '*' ? 'All LGAs' : zLga}, ${zState}.`);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const toggleZone = async (z: any) => {
    await apiFetch(`/api/admin/delivery-zones/${z.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isEnabled: !z.is_enabled }),
    });
    await load();
  };

  const deleteZone = async (id: string) => {
    await apiFetch(`/api/admin/delivery-zones/${id}`, { method: 'DELETE' });
    await load();
  };

  const createCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/admin/coupons', {
      method: 'POST',
      body: JSON.stringify({
        code: cCode,
        discountType: cType,
        discountValue: Number(cVal),
        minSpendNaira: Number(cMinSpend || 0),
      }),
    });
    setCCode('');
    setCVal('');
    setMsg('Discount code created.');
    await load();
  };

  const replyTicket = async (id: string) => {
    await apiFetch(`/api/admin/support/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'resolved', adminReply: replyMap[id] || '' }),
    });
    setMsg('Support ticket updated.');
    await load();
  };

  const submitPosOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (posItems.length === 0) return;
    setErr(null);
    try {
      const res = await apiFetch<any>('/api/admin/pos/order', {
        method: 'POST',
        body: JSON.stringify({
          items: posItems.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            quantity: i.quantity,
          })),
          customerName: posCustomer,
          discountNaira: Number(posDiscount || 0),
          markPaid: posPaid,
        }),
      });
      setPosItems([]);
      setMsg(`POS Order ${res.orderNumber} recorded (${formatNgn(res.totalKobo)}).`);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const stateLgas = getLgasForState(zState);

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

      {mode === 'customers' && (
        <div className="space-y-6">
          <div className="rounded-xl bg-white border border-slate-200 overflow-x-auto">
            <div className="p-4 border-b border-slate-200 font-bold text-sm text-[#172554]">
              Registered Customers ({customers.length})
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#F5F7F4] text-left text-slate-500 border-b border-slate-200">
                  <th className="p-3">Customer</th>
                  <th className="p-3">Phone</th>
                  <th className="p-3 text-right">Orders</th>
                  <th className="p-3 text-right">Total Spend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {customers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-slate-500">
                      No registered customers yet.
                    </td>
                  </tr>
                ) : (
                  customers.map((c) => (
                    <tr key={c.id}>
                      <td className="p-3">
                        <div className="font-semibold text-[#172554]">{c.name}</div>
                        <div className="text-slate-500">{c.email}</div>
                      </td>
                      <td className="p-3 text-slate-600">{c.phone || '—'}</td>
                      <td className="p-3 text-right tabular-nums">{c.order_count}</td>
                      <td className="p-3 text-right tabular-nums font-bold">
                        {formatNgn(c.total_spent_kobo)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-3">
              <h3 className="text-sm font-bold text-[#172554]">Support Tickets</h3>
              {tickets.length === 0 ? (
                <p className="text-xs text-slate-500">No support requests.</p>
              ) : (
                tickets.map((t) => (
                  <div key={t.id} className="border border-slate-200 rounded-lg p-3 text-xs space-y-2">
                    <div className="font-bold text-[#172554]">
                      {t.subject} · {t.status}
                    </div>
                    <div className="text-slate-500">
                      {t.customer_name} ({t.customer_email})
                    </div>
                    <p className="text-slate-700">{t.message}</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={replyMap[t.id] ?? t.admin_reply ?? ''}
                        onChange={(e) => setReplyMap((p) => ({ ...p, [t.id]: e.target.value }))}
                        placeholder="Reply to customer..."
                        className="flex-1 rounded border border-slate-300 px-2.5 py-1.5"
                      />
                      <button
                        type="button"
                        onClick={() => replyTicket(t.id)}
                        className="rounded bg-[#172554] px-3 py-1.5 font-semibold text-[#B7F36B]"
                      >
                        Resolve
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-3">
              <h3 className="text-sm font-bold text-[#172554]">Privacy & Data Requests</h3>
              {privacyReqs.length === 0 ? (
                <p className="text-xs text-slate-500">No privacy requests.</p>
              ) : (
                privacyReqs.map((pr) => (
                  <div key={pr.id} className="border border-slate-200 rounded-lg p-3 text-xs flex justify-between items-center">
                    <div>
                      <div className="font-bold uppercase text-[#172554]">
                        {pr.request_type} · {pr.status}
                      </div>
                      <div className="text-slate-500">
                        {pr.name} ({pr.email})
                      </div>
                    </div>
                    {pr.status === 'pending' && (
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/privacy-requests/${pr.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ status: 'completed' }),
                          });
                          await load();
                        }}
                        className="rounded bg-[#172554] px-3 py-1.5 font-semibold text-[#B7F36B]"
                      >
                        Mark Completed
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {mode === 'delivery' && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-bold text-[#172554]">Nigerian Delivery Zones & Fees</h2>
            <p className="text-xs text-slate-500">
              Checkout calculates fees strictly from enabled zones configured here. Unconfigured
              locations cannot proceed to checkout.
            </p>
          </div>

          <form
            onSubmit={addZone}
            className="rounded-xl bg-white border border-slate-200 p-5 grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs"
          >
            <div>
              <label className="block font-semibold mb-1">State *</label>
              <select
                value={zState}
                onChange={(e) => {
                  setZState(e.target.value);
                  setZLga('*');
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                {NIGERIAN_STATES_LGAS.map((s) => (
                  <option key={s.state} value={s.state}>
                    {s.state}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-semibold mb-1">LGA (or All LGAs)</label>
              <select
                value={zLga}
                onChange={(e) => setZLga(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="*">All LGAs in {zState}</option>
                {stateLgas.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-semibold mb-1">Delivery Fee (NGN) *</label>
              <input
                type="number"
                required
                min="0"
                step="0.01"
                value={zFee}
                onChange={(e) => setZFee(e.target.value)}
                placeholder="e.g. 3500"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <div>
              <label className="block font-semibold mb-1">Free Threshold (NGN)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={zFreeThreshold}
                onChange={(e) => setZFreeThreshold(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <div>
              <label className="block font-semibold mb-1">Min Days</label>
              <input
                type="number"
                min="1"
                value={zMinDays}
                onChange={(e) => setZMinDays(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <div>
              <label className="block font-semibold mb-1">Max Days</label>
              <input
                type="number"
                min="1"
                value={zMaxDays}
                onChange={(e) => setZMaxDays(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <div>
              <label className="block font-semibold mb-1">Courier / Logistics</label>
              <input
                type="text"
                value={zCourier}
                onChange={(e) => setZCourier(e.target.value)}
                placeholder="e.g. Dispatch Rider / Partner"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                className="w-full inline-flex items-center justify-center gap-1 rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
              >
                <Plus className="w-3.5 h-3.5" /> Add Zone
              </button>
            </div>
            <div className="sm:col-span-4">
              <input
                type="text"
                value={zInstructions}
                onChange={(e) => setZInstructions(e.target.value)}
                placeholder="Zone delivery instructions (optional)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
          </form>

          <div className="rounded-xl bg-white border border-slate-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#F5F7F4] text-left text-slate-500 border-b border-slate-200">
                  <th className="p-3">State</th>
                  <th className="p-3">LGA</th>
                  <th className="p-3 text-right">Fee</th>
                  <th className="p-3 text-right">Free Above</th>
                  <th className="p-3">ETA</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {zones.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-slate-500">
                      No delivery zones configured yet. Add a Nigerian State/LGA zone above to enable checkout.
                    </td>
                  </tr>
                ) : (
                  zones.map((z) => (
                    <tr key={z.id}>
                      <td className="p-3 font-semibold text-[#172554]">{z.state}</td>
                      <td className="p-3">{z.lga === '*' ? 'All LGAs' : z.lga}</td>
                      <td className="p-3 text-right tabular-nums font-bold">
                        {formatNgn(z.fee_kobo)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {z.free_threshold_kobo !== null ? formatNgn(z.free_threshold_kobo) : '—'}
                      </td>
                      <td className="p-3">
                        {z.estimated_days_min}–{z.estimated_days_max} days
                      </td>
                      <td className="p-3">{z.is_enabled ? 'Enabled' : 'Disabled'}</td>
                      <td className="p-3 text-right">
                        <div className="inline-flex gap-3">
                          <button
                            type="button"
                            onClick={() => toggleZone(z)}
                            className="text-[#172554] underline"
                          >
                            {z.is_enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteZone(z.id)}
                            className="text-slate-400 hover:text-[#F47B68]"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mode === 'marketing' && (
        <div className="space-y-6">
          <form
            onSubmit={createCoupon}
            className="rounded-xl bg-white border border-slate-200 p-5 grid grid-cols-1 sm:grid-cols-5 gap-3 text-xs items-end"
          >
            <div>
              <label className="block font-semibold mb-1">Coupon Code *</label>
              <input
                type="text"
                required
                value={cCode}
                onChange={(e) => setCCode(e.target.value)}
                placeholder="WELCOME10"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 uppercase"
              />
            </div>
            <div>
              <label className="block font-semibold mb-1">Type</label>
              <select
                value={cType}
                onChange={(e) => setCType(e.target.value as any)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="percentage">Percentage (%)</option>
                <option value="fixed">Fixed Amount (NGN)</option>
              </select>
            </div>
            <div>
              <label className="block font-semibold mb-1">Value *</label>
              <input
                type="number"
                required
                value={cVal}
                onChange={(e) => setCVal(e.target.value)}
                placeholder={cType === 'percentage' ? '10' : '5000'}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <div>
              <label className="block font-semibold mb-1">Min Spend (NGN)</label>
              <input
                type="number"
                value={cMinSpend}
                onChange={(e) => setCMinSpend(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <button
              type="submit"
              className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
            >
              Create Coupon
            </button>
          </form>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-3 text-xs">
              <h3 className="text-sm font-bold text-[#172554]">Discount Codes</h3>
              {coupons.length === 0 ? (
                <p className="text-slate-500">No coupons created yet.</p>
              ) : (
                coupons.map((cp) => (
                  <div key={cp.id} className="flex justify-between items-center border-b border-slate-100 pb-2">
                    <div>
                      <span className="font-mono-tabular font-bold text-[#172554]">{cp.code}</span>
                      <span className="text-slate-500 ml-2">
                        {cp.discount_type === 'percentage'
                          ? `${cp.discount_value}% off`
                          : `${formatNgn(cp.discount_value)} off`}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await apiFetch(`/api/admin/coupons/${cp.id}`, { method: 'DELETE' });
                        await load();
                      }}
                      className="text-slate-400 hover:text-[#F47B68]"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-3 text-xs">
              <h3 className="text-sm font-bold text-[#172554]">
                Newsletter Subscribers ({subscribers.length})
              </h3>
              {subscribers.length === 0 ? (
                <p className="text-slate-500">No subscribers yet.</p>
              ) : (
                subscribers.map((s) => (
                  <div key={s.id} className="py-1 border-b border-slate-100 text-slate-700">
                    {s.email}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {mode === 'pos' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 rounded-xl bg-white border border-slate-200 p-5 space-y-3">
            <h3 className="text-sm font-bold text-[#172554]">Point of Sale (POS) Catalog</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              {products.map((p) =>
                (p.variants || []).map((v: any) => (
                  <button
                    key={v.id}
                    type="button"
                    disabled={v.stock_quantity <= 0}
                    onClick={() => {
                      setPosItems((prev) => {
                        const idx = prev.findIndex((i) => i.variantId === v.id);
                        if (idx >= 0) {
                          const next = [...prev];
                          next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
                          return next;
                        }
                        return [
                          ...prev,
                          {
                            productId: p.id,
                            variantId: v.id,
                            name: `${p.name} (${v.name})`,
                            sku: v.sku,
                            priceKobo: v.sale_price_kobo ?? v.price_kobo,
                            quantity: 1,
                          },
                        ];
                      });
                    }}
                    className="text-left rounded-lg border border-slate-200 p-3 hover:border-[#172554] disabled:opacity-40"
                  >
                    <div className="font-bold text-[#172554] truncate">{p.name}</div>
                    <div className="text-slate-500">
                      {v.sku} · {v.stock_quantity} left
                    </div>
                    <div className="font-bold tabular-nums mt-1">
                      {formatNgn(v.sale_price_kobo ?? v.price_kobo)}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <form
            onSubmit={submitPosOrder}
            className="lg:col-span-5 rounded-xl bg-white border border-slate-200 p-5 space-y-4 text-xs"
          >
            <h3 className="text-sm font-bold text-[#172554]">POS Ticket</h3>
            <input
              type="text"
              value={posCustomer}
              onChange={(e) => setPosCustomer(e.target.value)}
              placeholder="Customer Name"
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
            />
            <div className="divide-y divide-slate-100 max-h-56 overflow-y-auto">
              {posItems.map((it) => (
                <div key={it.variantId} className="py-2 flex justify-between items-center">
                  <div>
                    <div className="font-semibold">{it.name}</div>
                    <div className="text-slate-500">Qty {it.quantity}</div>
                  </div>
                  <span className="font-bold tabular-nums">
                    {formatNgn(it.priceKobo * it.quantity)}
                  </span>
                </div>
              ))}
            </div>
            <div>
              <label className="block font-semibold mb-1">Discount (NGN)</label>
              <input
                type="number"
                min="0"
                value={posDiscount}
                onChange={(e) => setPosDiscount(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={posPaid}
                onChange={(e) => setPosPaid(e.target.checked)}
              />
              Mark as Paid & Collected In-Store
            </label>
            <button
              type="submit"
              disabled={posItems.length === 0}
              className="w-full rounded-lg bg-[#172554] px-4 py-2.5 font-bold text-[#B7F36B] disabled:opacity-40"
            >
              Complete POS Sale (
              {formatNgn(
                Math.max(
                  0,
                  posItems.reduce((s, i) => s + i.priceKobo * i.quantity, 0) -
                    Number(posDiscount || 0) * 100
                )
              )}
              )
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
