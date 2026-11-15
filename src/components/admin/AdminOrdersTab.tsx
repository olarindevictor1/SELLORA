import React, { useEffect, useState } from 'react';
import { Check, Printer, Search, X } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import {
  DELIVERY_STATUSES,
  DELIVERY_STATUS_LABELS,
  formatLagosDate,
  formatNgn,
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  type DeliveryStatus,
  type OrderStatus,
  type PaymentStatus,
} from '../../shared/types';

export const AdminOrdersTab: React.FC = () => {
  const [orders, setOrders] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<any>(null);

  // Order detail form state
  const [nextOrderStatus, setNextOrderStatus] = useState('');
  const [nextDeliveryStatus, setNextDeliveryStatus] = useState('');
  const [courierName, setCourierName] = useState('');
  const [trackingRef, setTrackingRef] = useState('');
  const [estDate, setEstDate] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [statusNote, setStatusNote] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadOrders = async () => {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (statusFilter) qs.set('orderStatus', statusFilter);
    const res = await apiFetch<{ orders: any[] }>(`/api/admin/orders?${qs.toString()}`);
    setOrders(res.orders || []);
  };

  useEffect(() => {
    loadOrders();
  }, [q, statusFilter]);

  const openOrder = async (orderId: string) => {
    const res = await apiFetch<any>(`/api/admin/orders/${orderId}`);
    setDetail(res);
    setNextOrderStatus(res.order.order_status);
    setNextDeliveryStatus(res.order.delivery_status);
    setCourierName(res.order.courier_name || '');
    setTrackingRef(res.order.tracking_reference || '');
    setEstDate(res.order.estimated_delivery_date || '');
    setInternalNotes(res.order.internal_notes || '');
    setDeliveryNotes(res.order.delivery_notes || '');
    setStatusNote('');
    setFeedback(null);
  };

  const acknowledgeOrder = async (orderId: string) => {
    await apiFetch(`/api/admin/orders/${orderId}/acknowledge`, { method: 'POST' });
    setFeedback('Order acknowledged as received (customer & admin notified).');
    await openOrder(orderId);
    await loadOrders();
  };

  const saveStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    await apiFetch(`/api/admin/orders/${detail.order.order_id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        orderStatus: nextOrderStatus,
        deliveryStatus: nextDeliveryStatus,
        courierName,
        trackingReference: trackingRef,
        estimatedDeliveryDate: estDate,
        internalNotes,
        deliveryNotes,
        note: statusNote,
      }),
    });
    setFeedback('Order updated and status history recorded.');
    await openOrder(detail.order.order_id);
    await loadOrders();
  };

  const handleRefund = async (status: 'refund_pending' | 'refunded') => {
    if (!detail) return;
    await apiFetch(`/api/admin/orders/${detail.order.order_id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ status, note: statusNote || `Marked ${status}` }),
    });
    setFeedback(`Order marked ${status}.`);
    await openOrder(detail.order.order_id);
    await loadOrders();
  };

  const runBulk = async (action: 'acknowledge' | 'mark_processing' | 'mark_ready_for_dispatch') => {
    if (selectedIds.size === 0) return;
    await apiFetch('/api/admin/orders/bulk', {
      method: 'POST',
      body: JSON.stringify({ orderIds: Array.from(selectedIds), action }),
    });
    setSelectedIds(new Set());
    await loadOrders();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#172554]">Orders & Fulfilment</h2>
          <p className="text-xs text-slate-500">
            Search by Order Number, Internal Order ID, Customer Name, Email, or Phone.
          </p>
        </div>
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => runBulk('acknowledge')}
              className="rounded-lg bg-[#172554] px-3 py-1.5 text-xs font-semibold text-[#B7F36B]"
            >
              Acknowledge ({selectedIds.size})
            </button>
            <button
              type="button"
              onClick={() => runBulk('mark_processing')}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#172554]"
            >
              Mark Processing
            </button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SLR-..., ord_..., customer name, email, phone..."
            className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
        >
          <option value="">All Order Statuses</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ORDER_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {/* Orders Table */}
      <div className="rounded-xl bg-white border border-slate-200 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[#F5F7F4] text-left text-slate-500 border-b border-slate-200">
              <th className="p-3 w-8"></th>
              <th className="p-3">Order</th>
              <th className="p-3">Customer</th>
              <th className="p-3">Location</th>
              <th className="p-3">Order Status</th>
              <th className="p-3">Payment</th>
              <th className="p-3 text-right">Total</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {orders.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-8 text-center text-slate-500">
                  No orders found matching filters.
                </td>
              </tr>
            ) : (
              orders.map((o) => (
                <tr key={o.order_id} className="hover:bg-[#F5F7F4]/60">
                  <td className="p-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(o.order_id)}
                      onChange={(e) => {
                        const next = new Set(selectedIds);
                        if (e.target.checked) next.add(o.order_id);
                        else next.delete(o.order_id);
                        setSelectedIds(next);
                      }}
                    />
                  </td>
                  <td className="p-3">
                    <div className="font-mono-tabular font-bold text-[#172554]">
                      {o.order_number}
                      {o.needs_attention ? (
                        <span className="ml-2 text-[10px] font-sans font-bold text-[#9A2E1E]">
                          · Attention
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {formatLagosDate(o.created_at)}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="font-semibold text-[#1E293B]">{o.customer_name}</div>
                    <div className="text-[11px] text-slate-500">{o.customer_email}</div>
                  </td>
                  <td className="p-3 text-slate-600">
                    {o.deliveryAddress?.lga}, {o.deliveryAddress?.state}
                  </td>
                  <td className="p-3 font-medium text-[#172554]">
                    {ORDER_STATUS_LABELS[o.order_status as OrderStatus] || o.order_status}
                  </td>
                  <td className="p-3 text-slate-600">
                    {PAYMENT_STATUS_LABELS[o.payment_status as PaymentStatus] || o.payment_status}
                  </td>
                  <td className="p-3 text-right font-bold tabular-nums text-[#172554]">
                    {formatNgn(o.total_kobo)}
                  </td>
                  <td className="p-3 text-right">
                    <button
                      type="button"
                      onClick={() => openOrder(o.order_id)}
                      className="rounded-lg border border-slate-300 px-3 py-1 font-semibold text-[#172554] hover:bg-[#172554] hover:text-[#B7F36B]"
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Order Detail Modal / Drawer */}
      {detail && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
          <div className="w-full max-w-2xl bg-white h-full overflow-y-auto p-6 space-y-6 shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-200 pb-4">
              <div>
                <h3 className="text-lg font-bold text-[#172554] font-mono-tabular">
                  {detail.order.order_number}
                </h3>
                <p className="text-[11px] font-mono-tabular text-slate-500">
                  ID: {detail.order.order_id} · Placed {formatLagosDate(detail.order.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-2 no-print">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700"
                >
                  <Printer className="w-3.5 h-3.5" /> Print Invoice
                </button>
                <button
                  type="button"
                  onClick={() => setDetail(null)}
                  className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {feedback && (
              <div className="rounded-lg bg-[#B7F36B]/30 border border-[#172554]/20 px-3.5 py-2.5 text-xs font-semibold text-[#172554]">
                {feedback}
              </div>
            )}

            {/* Quick Acknowledge */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#F5F7F4] border border-slate-200 p-4 text-xs">
              <div>
                <strong>Order Acknowledgement: </strong>
                {detail.order.acknowledged_at
                  ? `Received at ${formatLagosDate(detail.order.acknowledged_at)}`
                  : 'Not yet acknowledged'}
              </div>
              {!detail.order.acknowledged_at && (
                <button
                  type="button"
                  onClick={() => acknowledgeOrder(detail.order.order_id)}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#172554] px-3 py-1.5 font-bold text-[#B7F36B]"
                >
                  <Check className="w-3.5 h-3.5" /> Mark Order Received
                </button>
              )}
            </div>

            {/* Customer & Delivery Snapshot */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="rounded-xl border border-slate-200 p-4 space-y-1">
                <div className="font-bold text-[#172554]">Customer</div>
                <div>{detail.order.customer_name}</div>
                <div className="text-slate-500">{detail.order.customer_email}</div>
                <div className="text-slate-500">{detail.order.customer_phone}</div>
              </div>
              <div className="rounded-xl border border-slate-200 p-4 space-y-1">
                <div className="font-bold text-[#172554]">Immutable Delivery Snapshot</div>
                <div>{detail.order.deliveryAddress?.streetAddress}</div>
                <div>
                  {detail.order.deliveryAddress?.city}, {detail.order.deliveryAddress?.lga},{' '}
                  {detail.order.deliveryAddress?.state}
                </div>
                {detail.order.deliveryAddress?.additionalInstructions && (
                  <div className="text-slate-500">
                    Note: {detail.order.deliveryAddress.additionalInstructions}
                  </div>
                )}
              </div>
            </div>

            {/* Order Items */}
            <div className="rounded-xl border border-slate-200 p-4 space-y-2 text-xs">
              <div className="font-bold text-[#172554]">Items</div>
              {detail.items.map((it: any) => (
                <div key={it.order_item_id} className="flex justify-between py-1 border-b border-slate-100 last:border-0">
                  <div>
                    <span className="font-semibold">{it.product_name}</span> ({it.variant_name}) ·
                    SKU {it.sku} × {it.quantity}
                  </div>
                  <span className="font-bold tabular-nums">{formatNgn(it.line_total_kobo)}</span>
                </div>
              ))}
              <div className="pt-2 flex justify-between font-bold text-sm text-[#172554]">
                <span>Total (incl. {formatNgn(detail.order.delivery_fee_kobo)} delivery)</span>
                <span className="tabular-nums">{formatNgn(detail.order.total_kobo)}</span>
              </div>
            </div>

            {/* Private Payment Evidence Preview */}
            {detail.evidence?.length > 0 && (
              <div className="rounded-xl border border-slate-200 p-4 space-y-2 text-xs">
                <div className="font-bold text-[#172554]">Submitted Payment Evidence</div>
                {detail.evidence.map((ev: any) => (
                  <div key={ev.id} className="flex items-center justify-between gap-2 bg-[#F5F7F4] p-2.5 rounded-lg">
                    <div>
                      <div>
                        Ref: <strong>{ev.reference_number}</strong> ·{' '}
                        {formatNgn(ev.amount_submitted_kobo)} · {ev.transfer_date}
                      </div>
                      <div className="text-slate-500">{ev.receipt_original_name}</div>
                    </div>
                    <a
                      href={`/api/payments/evidence/${ev.id}/file`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg bg-[#172554] px-3 py-1.5 font-semibold text-[#B7F36B]"
                    >
                      Inspect Receipt
                    </a>
                  </div>
                ))}
              </div>
            )}

            {/* Status & Fulfilment Controls */}
            <form onSubmit={saveStatusUpdate} className="rounded-xl border border-slate-200 p-4 space-y-3 text-xs no-print">
              <div className="font-bold text-[#172554]">Update Processing & Fulfilment</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">Order Status</label>
                  <select
                    value={nextOrderStatus}
                    onChange={(e) => setNextOrderStatus(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-2"
                  >
                    {ORDER_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {ORDER_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Delivery Status</label>
                  <select
                    value={nextDeliveryStatus}
                    onChange={(e) => setNextDeliveryStatus(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-2"
                  >
                    {DELIVERY_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {DELIVERY_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  type="text"
                  value={courierName}
                  onChange={(e) => setCourierName(e.target.value)}
                  placeholder="Courier / Rider Name"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="text"
                  value={trackingRef}
                  onChange={(e) => setTrackingRef(e.target.value)}
                  placeholder="Courier Tracking Reference"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="date"
                  value={estDate}
                  onChange={(e) => setEstDate(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
                <input
                  type="text"
                  value={statusNote}
                  onChange={(e) => setStatusNote(e.target.value)}
                  placeholder="Status change reason / note"
                  className="rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>
              <textarea
                rows={2}
                value={deliveryNotes}
                onChange={(e) => setDeliveryNotes(e.target.value)}
                placeholder="Customer-visible delivery notes"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
              <textarea
                rows={2}
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                placeholder="Internal staff notes (hidden from customer)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  className="rounded-lg bg-[#172554] px-4 py-2 font-bold text-[#B7F36B]"
                >
                  Save Order Update
                </button>
                <button
                  type="button"
                  onClick={() => handleRefund('refund_pending')}
                  className="rounded-lg border border-slate-300 px-3 py-2 font-semibold text-slate-700"
                >
                  Mark Refund Pending
                </button>
                <button
                  type="button"
                  onClick={() => handleRefund('refunded')}
                  className="rounded-lg border border-[#F47B68] px-3 py-2 font-semibold text-[#9A2E1E]"
                >
                  Confirm Refunded
                </button>
              </div>
            </form>

            {/* History */}
            <div className="space-y-2 text-xs">
              <div className="font-bold text-[#172554]">Audit Status History</div>
              {detail.history.map((h: any) => (
                <div key={h.id} className="border-b border-slate-100 pb-2">
                  <div className="flex justify-between font-semibold">
                    <span>
                      {h.status_field}: {h.new_status} ({h.actor_name})
                    </span>
                    <span className="text-slate-400">{formatLagosDate(h.created_at)}</span>
                  </div>
                  {h.note && <div className="text-slate-600">{h.note}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
