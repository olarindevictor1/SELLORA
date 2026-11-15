import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Package, Search, Truck, Upload } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { trackConfirmedPurchase } from '../lib/analytics';
import {
  DELIVERY_STATUS_LABELS,
  formatLagosDate,
  formatNgn,
  ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  type DeliveryStatus,
  type OrderStatus,
  type PaymentStatus,
} from '../shared/types';

interface TrackOrderProps {
  initialOrderNumber?: string;
  user: any;
}

const TIMELINE_STEPS: Array<{ key: OrderStatus; label: string }> = [
  { key: 'pending_payment', label: 'Order Placed' },
  { key: 'payment_confirmed', label: 'Payment Confirmed' },
  { key: 'processing', label: 'Processing' },
  { key: 'ready_for_dispatch', label: 'Ready for Dispatch' },
  { key: 'out_for_delivery', label: 'Out for Delivery' },
  { key: 'delivered', label: 'Delivered' },
];

export const TrackOrderView: React.FC<TrackOrderProps> = ({ initialOrderNumber = '', user }) => {
  const [orderNumber, setOrderNumber] = useState(initialOrderNumber);
  const [verification, setVerification] = useState(user?.email || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  // Evidence upload inside tracking
  const [refNumber, setRefNumber] = useState('');
  const [amountNaira, setAmountNaira] = useState('');
  const [transferDate, setTransferDate] = useState(new Date().toISOString().slice(0, 10));
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const performLookup = async (ordNum: string, verif: string) => {
    if (!ordNum.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<any>('/api/tracking/lookup', {
        method: 'POST',
        body: JSON.stringify({
          orderNumber: ordNum.trim(),
          verification: verif.trim(),
        }),
      });
      setResult(res);
      setAmountNaira(String(Number(res.order.totalKobo) / 100));
      if (res.order?.paymentStatus === 'payment_confirmed') {
        trackConfirmedPurchase({
          orderNumber: res.order.orderNumber,
          paymentStatus: res.order.paymentStatus,
          totalKobo: Number(res.order.totalKobo || 0),
          deliveryFeeKobo: Number(res.order.deliveryFeeKobo || 0),
          items: res.items || [],
        });
      }
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : 'Unable to locate order.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialOrderNumber) {
      setOrderNumber(initialOrderNumber);
      if (user) {
        performLookup(initialOrderNumber, user.email || '');
      }
    }
  }, [initialOrderNumber]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    performLookup(orderNumber, verification);
  };

  const handleEvidenceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!result || !receiptFile) return;
    setUploadMsg(null);
    setUploadErr(null);
    try {
      const form = new FormData();
      form.append('verificationEmail', verification || user?.email || '');
      form.append('referenceNumber', refNumber);
      form.append('amountNaira', amountNaira);
      form.append('transferDate', transferDate);
      form.append('receipt', receiptFile);
      await apiFetch(`/api/payments/${encodeURIComponent(result.order.orderNumber)}/evidence`, {
        method: 'POST',
        body: form,
      });
      setUploadMsg('Payment proof submitted for administrator review.');
      setRefNumber('');
      setReceiptFile(null);
      await performLookup(result.order.orderNumber, verification || user?.email || '');
    } catch (err) {
      setUploadErr(err instanceof Error ? err.message : 'Failed to upload receipt.');
    }
  };

  const ord = result?.order;
  const activeStepIdx = ord
    ? TIMELINE_STEPS.findIndex((s) => s.key === ord.orderStatus)
    : -1;
  const isExceptional =
    ord &&
    [
      'payment_under_review',
      'cancellation_requested',
      'cancelled',
      'refund_pending',
      'refunded',
    ].includes(ord.orderStatus);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 pb-24 space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-[#172554]">Track Your Order</h1>
        <p className="text-sm text-slate-600 mt-1">
          Verify your Order Number with the email address or phone number used at checkout.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl bg-white border border-slate-200 p-6 grid grid-cols-1 sm:grid-cols-12 gap-4 items-end"
      >
        <div className="sm:col-span-5">
          <label className="block text-xs font-semibold text-[#1E293B] mb-1.5">
            Order Number
          </label>
          <input
            type="text"
            required
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="e.g. SLR-20261114-A1B2C3"
            className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-mono-tabular uppercase"
          />
        </div>
        <div className="sm:col-span-5">
          <label className="block text-xs font-semibold text-[#1E293B] mb-1.5">
            Order Email or Phone Number {!user ? '*' : '(optional if signed in)'}
          </label>
          <input
            type="text"
            required={!user}
            value={verification}
            onChange={(e) => setVerification(e.target.value)}
            placeholder="you@example.com or 0803..."
            className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm"
          />
        </div>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#172554] px-4 py-2.5 text-sm font-bold text-[#B7F36B] hover:bg-[#1E3A8A] disabled:opacity-60"
          >
            <Search className="w-4 h-4" />
            <span>{loading ? '...' : 'Track'}</span>
          </button>
        </div>
      </form>

      {error && (
        <div className="rounded-xl bg-[#F47B68]/15 border border-[#F47B68]/40 p-4 text-sm text-[#9A2E1E]">
          {error}
        </div>
      )}

      {ord && (
        <div className="space-y-6">
          {/* Header Summary */}
          <div className="rounded-2xl bg-white border border-slate-200 p-6 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs text-slate-500">
                  Placed {formatLagosDate(ord.createdAt)}
                </div>
                <h2 className="text-xl font-bold text-[#172554] font-mono-tabular mt-0.5">
                  {ord.orderNumber}
                </h2>
              </div>
              <div className="text-right space-y-1">
                <div className="text-xs text-slate-500">Order Total</div>
                <div className="text-xl font-bold text-[#172554] tabular-nums">
                  {formatNgn(ord.totalKobo)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-100 text-xs">
              <div>
                <span className="text-slate-500 block">Order Status</span>
                <strong className="text-sm text-[#172554]">
                  {ORDER_STATUS_LABELS[ord.orderStatus as OrderStatus] || ord.orderStatus}
                </strong>
              </div>
              <div>
                <span className="text-slate-500 block">Payment Status</span>
                <strong className="text-sm text-[#1E293B]">
                  {PAYMENT_STATUS_LABELS[ord.paymentStatus as PaymentStatus] || ord.paymentStatus}
                </strong>
              </div>
              <div>
                <span className="text-slate-500 block">Delivery Status</span>
                <strong className="text-sm text-[#1E293B]">
                  {DELIVERY_STATUS_LABELS[ord.deliveryStatus as DeliveryStatus] || ord.deliveryStatus}
                </strong>
              </div>
            </div>

            {/* Visual Progress Timeline */}
            <div className="pt-4 border-t border-slate-100">
              {isExceptional && (
                <div className="mb-4 rounded-xl bg-[#F5F7F4] border border-slate-200 p-3.5 flex items-start gap-2.5 text-xs text-[#1E293B]">
                  <AlertTriangle className="w-4 h-4 text-[#F47B68] shrink-0 mt-0.5" />
                  <div>
                    <strong>Current State: </strong>
                    {ORDER_STATUS_LABELS[ord.orderStatus as OrderStatus] || ord.orderStatus}
                    {result.payment?.rejection_reason && (
                      <div className="text-[#9A2E1E] mt-1">
                        Payment Rejection Reason: {result.payment.rejection_reason}
                      </div>
                    )}
                    {ord.cancellationReason && (
                      <div className="text-slate-600 mt-1">Reason: {ord.cancellationReason}</div>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                {TIMELINE_STEPS.map((step, idx) => {
                  const completed =
                    activeStepIdx >= idx ||
                    (step.key === 'pending_payment' && ord.orderStatus === 'payment_under_review');
                  return (
                    <div
                      key={step.key}
                      className={`rounded-xl border p-3 text-xs ${
                        completed
                          ? 'bg-[#172554] text-white border-[#172554]'
                          : 'bg-[#F5F7F4] text-slate-500 border-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 font-semibold">
                        <CheckCircle2
                          className={`w-3.5 h-3.5 shrink-0 ${
                            completed ? 'text-[#B7F36B]' : 'text-slate-400'
                          }`}
                        />
                        <span>{step.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Delivery & Items */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="rounded-2xl bg-white border border-slate-200 p-6 space-y-3 text-sm">
              <div className="flex items-center gap-2 font-bold text-[#172554]">
                <Truck className="w-4 h-4" />
                <span>Delivery Information</span>
              </div>
              <p className="font-medium text-[#1E293B]">{ord.deliveryAddress.fullName}</p>
              <p className="text-xs text-slate-600">
                {ord.deliveryAddress.streetAddress}, {ord.deliveryAddress.city},{' '}
                {ord.deliveryAddress.lga}, {ord.deliveryAddress.state}
              </p>
              {ord.estimatedDeliveryDate && (
                <p className="text-xs text-slate-600">
                  Estimated Delivery: <strong>{ord.estimatedDeliveryDate}</strong>
                </p>
              )}
              {ord.courierName && (
                <p className="text-xs text-slate-600">
                  Courier: <strong>{ord.courierName}</strong>{' '}
                  {ord.trackingReference ? `· Ref: ${ord.trackingReference}` : ''}
                </p>
              )}
              {ord.deliveryNotes && (
                <p className="text-xs text-slate-600">Delivery Note: {ord.deliveryNotes}</p>
              )}
            </div>

            <div className="rounded-2xl bg-white border border-slate-200 p-6 space-y-3">
              <div className="flex items-center gap-2 font-bold text-sm text-[#172554]">
                <Package className="w-4 h-4" />
                <span>Items in Order</span>
              </div>
              <div className="divide-y divide-slate-100 text-xs">
                {result.items.map((it: any) => (
                  <div key={it.order_item_id} className="py-2 flex justify-between gap-3">
                    <div>
                      <div className="font-semibold text-[#1E293B]">{it.product_name}</div>
                      <div className="text-slate-500">
                        {it.variant_name} · Qty {it.quantity}
                      </div>
                    </div>
                    <div className="font-semibold tabular-nums text-[#172554]">
                      {formatNgn(it.line_total_kobo)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Upload / Resubmit Payment Proof if unpaid or rejected */}
          {(ord.paymentStatus === 'pending_payment' || ord.paymentStatus === 'payment_rejected') && (
            <form
              onSubmit={handleEvidenceSubmit}
              className="rounded-2xl bg-white border border-slate-200 p-6 space-y-4"
            >
              <div className="flex items-center gap-2 text-sm font-bold text-[#172554]">
                <Upload className="w-4 h-4" />
                <span>Upload Bank Transfer Proof</span>
              </div>
              {uploadMsg && (
                <div className="rounded-lg bg-[#B7F36B]/30 px-3 py-2 text-xs font-semibold text-[#172554]">
                  {uploadMsg}
                </div>
              )}
              {uploadErr && (
                <div className="rounded-lg bg-[#F47B68]/15 px-3 py-2 text-xs text-[#9A2E1E]">
                  {uploadErr}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="text"
                  required
                  value={refNumber}
                  onChange={(e) => setRefNumber(e.target.value)}
                  placeholder="Transfer Reference"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  step="0.01"
                  required
                  value={amountNaira}
                  onChange={(e) => setAmountNaira(e.target.value)}
                  placeholder="Amount (NGN)"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <input
                  type="date"
                  required
                  value={transferDate}
                  onChange={(e) => setTransferDate(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <input
                  type="file"
                  required
                  accept="image/png,image/jpeg,image/webp,application/pdf"
                  onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                  className="text-xs text-slate-600"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-[#172554] px-4 py-2 text-xs font-bold text-[#B7F36B]"
                >
                  Submit Receipt
                </button>
              </div>
            </form>
          )}

          {/* Timestamped Status History */}
          <div className="rounded-2xl bg-white border border-slate-200 p-6 space-y-4">
            <h3 className="text-sm font-bold text-[#172554]">Timestamped Status History</h3>
            <div className="space-y-3">
              {result.history.map((h: any) => (
                <div
                  key={h.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs border-b border-slate-100 pb-2.5 last:border-0"
                >
                  <div>
                    <span className="font-semibold text-[#172554] capitalize">
                      {h.status_field}: {String(h.new_status).replace(/_/g, ' ')}
                    </span>
                    {h.note && <p className="text-slate-600 mt-0.5">{h.note}</p>}
                  </div>
                  <span className="text-slate-400 tabular-nums shrink-0">
                    {formatLagosDate(h.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
