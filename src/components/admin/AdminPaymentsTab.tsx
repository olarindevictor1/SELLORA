import React, { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { formatLagosDate, formatNgn, PAYMENT_STATUS_LABELS, type PaymentStatus } from '../../shared/types';

export const AdminPaymentsTab: React.FC = () => {
  const [payments, setPayments] = useState<any[]>([]);
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const res = await apiFetch<{ payments: any[] }>('/api/admin/payments');
    setPayments(res.payments || []);
  };

  useEffect(() => {
    load();
  }, []);

  const verify = async (orderId: string) => {
    setMsg(null);
    setErr(null);
    try {
      await apiFetch(`/api/admin/payments/${orderId}/verify`, { method: 'POST' });
      setMsg('Payment verified and confirmed. Notifications queued.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const reject = async (orderId: string) => {
    setMsg(null);
    setErr(null);
    const reason = (rejectionReasons[orderId] || '').trim();
    if (reason.length < 3) {
      setErr('Please enter a clear rejection reason before rejecting.');
      return;
    }
    try {
      await apiFetch(`/api/admin/payments/${orderId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setMsg('Payment rejected and customer notified.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-[#172554]">Manual Payment Review</h2>
        <p className="text-xs text-slate-500">
          Inspect private bank transfer receipts and approve or reject manually. Uploading evidence
          never marks an order paid automatically.
        </p>
      </div>

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

      {payments.length === 0 ? (
        <div className="rounded-xl bg-white border border-slate-200 p-10 text-center text-sm text-slate-500">
          No payments recorded yet.
        </div>
      ) : (
        <div className="space-y-4">
          {payments.map((p) => (
            <div key={p.id} className="rounded-xl bg-white border border-slate-200 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-mono-tabular font-bold text-[#172554] text-sm">
                    {p.order_number} · {p.customer_name}
                  </div>
                  <div className="text-xs text-slate-500">
                    {p.customer_email} · Expected:{' '}
                    <strong className="text-[#172554] tabular-nums">
                      {formatNgn(p.expected_amount_kobo)}
                    </strong>
                  </div>
                </div>
                <div className="text-xs font-bold text-[#172554]">
                  {PAYMENT_STATUS_LABELS[p.status as PaymentStatus] || p.status}
                </div>
              </div>

              {p.evidence?.length > 0 ? (
                <div className="space-y-2">
                  {p.evidence.map((ev: any) => (
                    <div
                      key={ev.id}
                      className="rounded-lg bg-[#F5F7F4] border border-slate-200 p-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                    >
                      <div>
                        <div>
                          Ref: <strong className="font-mono-tabular">{ev.reference_number}</strong> ·
                          Amount:{' '}
                          <strong className="tabular-nums">
                            {formatNgn(ev.amount_submitted_kobo)}
                          </strong>{' '}
                          · Date: {ev.transfer_date}
                        </div>
                        <div className="text-slate-500 mt-0.5">
                          Submitted {formatLagosDate(ev.created_at)} · {ev.receipt_original_name}
                        </div>
                      </div>
                      <a
                        href={`/api/payments/evidence/${ev.id}/file`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-[#172554] px-3 py-1.5 font-semibold text-[#172554] hover:bg-[#172554] hover:text-[#B7F36B]"
                      >
                        View Private Receipt <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">Customer has not uploaded payment evidence yet.</p>
              )}

              {p.status !== 'payment_confirmed' && (
                <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => verify(p.order_id)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#172554] px-4 py-2 text-xs font-bold text-[#B7F36B]"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> Approve & Confirm Payment
                  </button>
                  <input
                    type="text"
                    value={rejectionReasons[p.order_id] || ''}
                    onChange={(e) =>
                      setRejectionReasons((prev) => ({ ...prev, [p.order_id]: e.target.value }))
                    }
                    placeholder="Rejection reason if invalid..."
                    className="flex-1 min-w-[200px] rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => reject(p.order_id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#F47B68] px-3.5 py-2 text-xs font-semibold text-[#9A2E1E]"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
