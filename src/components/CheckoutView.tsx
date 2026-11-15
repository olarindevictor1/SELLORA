import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle2, Landmark, Upload } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatNgn } from '../shared/types';
import { NigerianAddressForm, type NigerianAddressInput } from './NigerianAddressForm';
import { TurnstileWidget } from './TurnstileWidget';

export interface CartItemView {
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitPriceKobo: number;
  image?: string;
  quantity: number;
  maxStock?: number;
}

interface CheckoutViewProps {
  items: CartItemView[];
  user: any;
  bankTransfer: {
    configured: boolean;
    bankName: string;
    accountName: string;
    accountNumber: string;
    paymentInstructions: string;
    referenceInstructions: string;
  };
  turnstileSiteKey?: string | null;
  onBack: () => void;
  onOrderCreated: () => void;
  onTrackOrder: (orderNumber: string) => void;
}

export const CheckoutView: React.FC<CheckoutViewProps> = ({
  items,
  user,
  bankTransfer,
  turnstileSiteKey = null,
  onBack,
  onOrderCreated,
  onTrackOrder,
}) => {
  const [savedAddresses, setSavedAddresses] = useState<any[]>([]);
  const [address, setAddress] = useState<NigerianAddressInput>({
    fullName: user?.name || '',
    email: user?.email || '',
    phone: user?.phone || '',
    state: '',
    lga: '',
    city: '',
    streetAddress: '',
    additionalInstructions: '',
  });
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<{
    code: string;
    discountKobo: number;
  } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);

  const [deliveryQuote, setDeliveryQuote] = useState<any>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [confirmedOrder, setConfirmedOrder] = useState<any>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  // Payment evidence form right after checkout
  const [refNumber, setRefNumber] = useState('');
  const [amountNaira, setAmountNaira] = useState('');
  const [transferDate, setTransferDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [evidenceMessage, setEvidenceMessage] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const subtotalKobo = items.reduce((s, i) => s + i.unitPriceKobo * i.quantity, 0);
  const discountKobo = appliedCoupon?.discountKobo || 0;
  const discountedSubtotal = Math.max(0, subtotalKobo - discountKobo);
  const deliveryFeeKobo = deliveryQuote?.available ? Number(deliveryQuote.feeKobo) : 0;
  const totalKobo = discountedSubtotal + deliveryFeeKobo;

  useEffect(() => {
    if (!user) return;
    apiFetch<{ addresses: any[] }>('/api/addresses')
      .then((res) => {
        setSavedAddresses(res.addresses || []);
        const def = res.addresses?.find((a) => a.is_default) || res.addresses?.[0];
        if (def) {
          setAddress({
            fullName: def.full_name,
            email: def.email,
            phone: def.phone,
            state: def.state,
            lga: def.lga,
            city: def.city,
            streetAddress: def.street_address,
            additionalInstructions: def.additional_instructions || '',
          });
        }
      })
      .catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!address.state || !address.lga) {
      setDeliveryQuote(null);
      return;
    }
    setQuoteLoading(true);
    apiFetch('/api/delivery/quote', {
      method: 'POST',
      body: JSON.stringify({
        state: address.state,
        lga: address.lga,
        subtotalKobo: discountedSubtotal,
      }),
    })
      .then(setDeliveryQuote)
      .catch(() => setDeliveryQuote(null))
      .finally(() => setQuoteLoading(false));
  }, [address.state, address.lga, discountedSubtotal]);

  const applyCoupon = async () => {
    setCouponError(null);
    try {
      const res = await apiFetch<any>('/api/coupons/validate', {
        method: 'POST',
        body: JSON.stringify({ code: couponInput, subtotalKobo }),
      });
      setAppliedCoupon({ code: res.code, discountKobo: res.discountKobo });
    } catch (err) {
      setAppliedCoupon(null);
      setCouponError(err instanceof Error ? err.message : 'Invalid coupon');
    }
  };

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setCheckoutError(null);
    if (!deliveryQuote?.available) {
      setCheckoutError(
        deliveryQuote?.reason ||
          'Delivery is unavailable for the selected Nigerian State/LGA. Please pick an enabled zone.'
      );
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setCheckoutError('Please complete the Cloudflare Turnstile security verification check.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<any>('/api/checkout', {
        method: 'POST',
        body: JSON.stringify({
          items: items.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            quantity: i.quantity,
          })),
          address,
          couponCode: appliedCoupon?.code || null,
          idempotencyKey: `chk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          turnstileToken: turnstileToken || undefined,
          source: 'web',
        }),
      });
      setConfirmedOrder(res);
      setAmountNaira(String(res.totalKobo / 100));
      onOrderCreated();
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'Unable to place order.');
      setTurnstileToken(null);
      setTurnstileResetKey((k) => k + 1);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUploadEvidence = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmedOrder || !receiptFile) return;
    setEvidenceError(null);
    setEvidenceMessage(null);
    setUploadingEvidence(true);
    try {
      const form = new FormData();
      form.append('verificationEmail', address.email);
      form.append('referenceNumber', refNumber);
      form.append('amountNaira', amountNaira);
      form.append('transferDate', transferDate);
      form.append('notes', notes);
      form.append('receipt', receiptFile);
      form.append('idempotencyKey', `ev_${confirmedOrder.orderNumber}_${Date.now()}`);

      await apiFetch(`/api/payments/${encodeURIComponent(confirmedOrder.orderNumber)}/evidence`, {
        method: 'POST',
        body: form,
      });
      setEvidenceMessage(
        'Payment evidence uploaded privately! Your order is now Payment Under Review awaiting administrator verification.'
      );
      setRefNumber('');
      setReceiptFile(null);
    } catch (err) {
      setEvidenceError(err instanceof Error ? err.message : 'Failed to upload receipt.');
    } finally {
      setUploadingEvidence(false);
    }
  };

  if (confirmedOrder) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 space-y-6">
        <div className="rounded-2xl bg-white border border-slate-200 p-6 sm:p-8 space-y-6">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-[#B7F36B] p-3 text-[#172554] shrink-0">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-500">Order Confirmed · Pending Payment</div>
              <h1 className="text-2xl font-bold text-[#172554] mt-0.5">
                Order {confirmedOrder.orderNumber}
              </h1>
              <p className="text-xs text-slate-500 font-mono-tabular mt-1">
                Internal Order ID: {confirmedOrder.orderId}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-200">
            <div className="rounded-xl bg-[#F5F7F4] border border-slate-200 p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-[#172554]">
                <Landmark className="w-4 h-4" />
                <span>Manual Bank Transfer Instructions</span>
              </div>
              {bankTransfer.configured ? (
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Bank</span>
                    <span className="font-semibold text-[#1E293B]">{bankTransfer.bankName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Account Name</span>
                    <span className="font-semibold text-[#1E293B]">{bankTransfer.accountName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Account Number</span>
                    <span className="font-mono-tabular font-bold text-[#172554]">
                      {bankTransfer.accountNumber}
                    </span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-slate-200">
                    <span className="text-slate-500">Amount Due</span>
                    <span className="font-bold text-[#172554] tabular-nums">
                      {formatNgn(confirmedOrder.totalKobo)}
                    </span>
                  </div>
                  {bankTransfer.paymentInstructions && (
                    <p className="text-xs text-slate-600 pt-2">{bankTransfer.paymentInstructions}</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-[#9A2E1E] leading-relaxed">
                  Store bank account details have not been configured by the owner yet. Please
                  contact store support or check back on your Track Order page once configured.
                </p>
              )}
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-5 space-y-2 text-sm">
              <div className="font-bold text-[#172554]">Delivery Summary</div>
              <p className="text-slate-700 font-medium">{confirmedOrder.addressSnapshot.fullName}</p>
              <p className="text-slate-600 text-xs leading-relaxed">
                {confirmedOrder.addressSnapshot.streetAddress}, {confirmedOrder.addressSnapshot.city},{' '}
                {confirmedOrder.addressSnapshot.lga}, {confirmedOrder.addressSnapshot.state}
              </p>
              <p className="text-xs text-slate-500">
                Estimated Delivery Date:{' '}
                <strong className="text-[#1E293B]">{confirmedOrder.estimatedDeliveryDate}</strong>
              </p>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => onTrackOrder(confirmedOrder.orderNumber)}
                  className="text-xs font-bold text-[#172554] underline"
                >
                  Open in Track Order →
                </button>
              </div>
            </div>
          </div>

          {/* Payment Evidence Upload */}
          <form
            onSubmit={handleUploadEvidence}
            className="rounded-xl border border-slate-200 p-5 space-y-4 bg-white"
          >
            <div className="flex items-center gap-2 text-sm font-bold text-[#172554]">
              <Upload className="w-4 h-4" />
              <span>Submit Bank Transfer Evidence</span>
            </div>
            <p className="text-xs text-slate-600">
              Receipts are stored privately and reviewed by an authorized store administrator.
              Uploading evidence places your order under review and does not automatically mark it paid.
            </p>

            {evidenceError && (
              <div className="rounded-lg bg-[#F47B68]/15 border border-[#F47B68]/40 px-3 py-2 text-xs text-[#9A2E1E]">
                {evidenceError}
              </div>
            )}
            {evidenceMessage && (
              <div className="rounded-lg bg-[#B7F36B]/30 border border-[#172554]/20 px-3 py-2 text-xs font-semibold text-[#172554]">
                {evidenceMessage}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold mb-1">Transfer Reference *</label>
                <input
                  type="text"
                  required
                  value={refNumber}
                  onChange={(e) => setRefNumber(e.target.value)}
                  placeholder="Bank session / ref ID"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">Amount Paid (NGN) *</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={amountNaira}
                  onChange={(e) => setAmountNaira(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">Transfer Date *</label>
                <input
                  type="date"
                  required
                  value={transferDate}
                  onChange={(e) => setTransferDate(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold mb-1">
                  Receipt File (PNG, JPG, WEBP, PDF ≤ 5MB) *
                </label>
                <input
                  type="file"
                  required
                  accept="image/png,image/jpeg,image/webp,application/pdf"
                  onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-[#172554] file:px-3 file:py-2 file:text-xs file:font-semibold file:text-[#B7F36B]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Sender account name"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={uploadingEvidence || !receiptFile}
              className="rounded-lg bg-[#172554] px-5 py-2.5 text-sm font-bold text-[#B7F36B] hover:bg-[#1E3A8A] disabled:opacity-50"
            >
              {uploadingEvidence ? 'Uploading Securely...' : 'Submit Payment Proof'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 pb-20">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-[#172554] mb-6"
      >
        <ArrowLeft className="w-4 h-4" /> Continue Shopping
      </button>

      <h1 className="text-2xl sm:text-3xl font-bold text-[#172554] mb-8">Checkout</h1>

      {items.length === 0 ? (
        <div className="rounded-2xl bg-white border border-slate-200 p-10 text-center">
          <p className="text-sm text-slate-600">Your shopping bag is empty.</p>
        </div>
      ) : (
        <form onSubmit={handlePlaceOrder} className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-7 space-y-6">
            {/* Saved Address Selector */}
            {savedAddresses.length > 0 && (
              <div className="rounded-2xl bg-white border border-slate-200 p-6 space-y-3">
                <h2 className="text-sm font-bold text-[#172554]">Saved Nigerian Addresses</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {savedAddresses.map((sa) => (
                    <button
                      key={sa.address_id}
                      type="button"
                      onClick={() =>
                        setAddress({
                          fullName: sa.full_name,
                          email: sa.email,
                          phone: sa.phone,
                          state: sa.state,
                          lga: sa.lga,
                          city: sa.city,
                          streetAddress: sa.street_address,
                          additionalInstructions: sa.additional_instructions || '',
                        })
                      }
                      className="text-left rounded-xl border border-slate-200 p-3.5 hover:border-[#172554] transition-colors text-xs space-y-1"
                    >
                      <div className="font-bold text-[#172554]">
                        {sa.full_name} {sa.is_default ? '· Default' : ''}
                      </div>
                      <div className="text-slate-600">
                        {sa.street_address}, {sa.city}
                      </div>
                      <div className="text-slate-500">
                        {sa.lga}, {sa.state}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Nigerian Delivery Address Form */}
            <div className="rounded-2xl bg-white border border-slate-200 p-6 space-y-5">
              <div>
                <h2 className="text-base font-bold text-[#172554]">Nigerian Delivery Details</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Select State → Local Government Area (LGA) → City/Town → Street Address
                </p>
              </div>
              <NigerianAddressForm value={address} onChange={setAddress} />
            </div>

            {/* Payment Method */}
            <div className="rounded-2xl bg-white border border-slate-200 p-6 space-y-3">
              <div className="flex items-center gap-2 text-base font-bold text-[#172554]">
                <Landmark className="w-4 h-4" />
                <span>Manual Bank Transfer</span>
              </div>
              {bankTransfer.configured ? (
                <div className="rounded-xl bg-[#F5F7F4] border border-slate-200 p-4 text-xs space-y-1.5">
                  <div>
                    Bank: <strong>{bankTransfer.bankName}</strong> · Account Name:{' '}
                    <strong>{bankTransfer.accountName}</strong>
                  </div>
                  <div>
                    Account Number:{' '}
                    <strong className="font-mono-tabular text-[#172554]">
                      {bankTransfer.accountNumber}
                    </strong>
                  </div>
                  <p className="text-slate-600 pt-1">{bankTransfer.referenceInstructions}</p>
                </div>
              ) : (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-xs text-amber-900">
                  Bank transfer instructions have not yet been configured by the store owner in Admin
                  Settings. You can still place an order if delivery is enabled, or configure bank
                  details first.
                </div>
              )}
            </div>
          </div>

          {/* Order Summary Sidebar */}
          <div className="lg:col-span-5 rounded-2xl bg-white border border-slate-200 p-6 space-y-5 lg:sticky lg:top-24">
            <h2 className="text-base font-bold text-[#172554]">Order Summary</h2>
            <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
              {items.map((item) => (
                <div key={item.variantId} className="py-3 flex justify-between gap-3 text-sm">
                  <div>
                    <div className="font-semibold text-[#1E293B]">{item.productName}</div>
                    <div className="text-xs text-slate-500">
                      {item.variantName} · Qty {item.quantity}
                    </div>
                  </div>
                  <div className="font-semibold text-[#172554] tabular-nums shrink-0">
                    {formatNgn(item.unitPriceKobo * item.quantity)}
                  </div>
                </div>
              ))}
            </div>

            {/* Coupon */}
            <div className="pt-2 border-t border-slate-200 space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value)}
                  placeholder="Discount code"
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs uppercase"
                />
                <button
                  type="button"
                  onClick={applyCoupon}
                  className="rounded-lg border border-[#172554] px-3.5 py-2 text-xs font-semibold text-[#172554] hover:bg-[#172554] hover:text-[#B7F36B] transition-colors"
                >
                  Apply
                </button>
              </div>
              {couponError && <p className="text-xs text-[#9A2E1E]">{couponError}</p>}
              {appliedCoupon && (
                <p className="text-xs text-emerald-700 font-semibold">
                  Code {appliedCoupon.code} applied (-{formatNgn(appliedCoupon.discountKobo)})
                </p>
              )}
            </div>

            {/* Delivery Fee Status */}
            <div className="rounded-xl bg-[#F5F7F4] border border-slate-200 p-4 text-xs space-y-1.5">
              {!address.state || !address.lga ? (
                <p className="text-slate-600">Select State and LGA to calculate delivery fee.</p>
              ) : quoteLoading ? (
                <p className="text-slate-600">Checking configured delivery zone...</p>
              ) : deliveryQuote?.available ? (
                <>
                  <div className="flex justify-between font-semibold text-[#172554]">
                    <span>
                      Delivery ({address.lga}, {address.state})
                    </span>
                    <span className="tabular-nums">
                      {deliveryQuote.feeKobo === 0 ? 'Free' : formatNgn(deliveryQuote.feeKobo)}
                    </span>
                  </div>
                  <div className="text-slate-500">
                    Est. {deliveryQuote.estimatedDaysMin}–{deliveryQuote.estimatedDaysMax} business
                    days {deliveryQuote.courierName ? `· ${deliveryQuote.courierName}` : ''}
                  </div>
                </>
              ) : (
                <div className="flex items-start gap-2 text-[#9A2E1E]">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {deliveryQuote?.reason ||
                      `Delivery is unavailable for ${address.lga}, ${address.state}.`}
                  </span>
                </div>
              )}
            </div>

            {/* Totals */}
            <div className="space-y-2 pt-2 border-t border-slate-200 text-sm">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatNgn(subtotalKobo)}</span>
              </div>
              {discountKobo > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <span>Discount</span>
                  <span className="tabular-nums">-{formatNgn(discountKobo)}</span>
                </div>
              )}
              <div className="flex justify-between text-slate-600">
                <span>Delivery Fee</span>
                <span className="tabular-nums">
                  {deliveryQuote?.available ? formatNgn(deliveryFeeKobo) : '—'}
                </span>
              </div>
              <div className="flex justify-between text-base font-bold text-[#172554] pt-2 border-t border-slate-200">
                <span>Total (NGN)</span>
                <span className="tabular-nums">{formatNgn(totalKobo)}</span>
              </div>
            </div>

            <TurnstileWidget
              siteKey={turnstileSiteKey}
              resetKey={turnstileResetKey}
              onToken={setTurnstileToken}
              onError={(msg) => setCheckoutError(msg)}
            />

            {checkoutError && (
              <div className="rounded-lg bg-[#F47B68]/15 border border-[#F47B68]/40 px-3.5 py-2.5 text-xs font-medium text-[#9A2E1E]">
                {checkoutError}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !deliveryQuote?.available || Boolean(turnstileSiteKey && !turnstileToken)}
              className="w-full rounded-xl bg-[#172554] px-5 py-3.5 text-sm font-bold text-[#B7F36B] hover:bg-[#1E3A8A] disabled:bg-slate-200 disabled:text-slate-500 transition-colors"
            >
              {submitting ? 'Confirming Order...' : 'Place Order'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
