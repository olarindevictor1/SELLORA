import React, { useEffect, useState } from 'react';
import { Download, Heart, LogOut, MapPin, Package, Plus, Trash2, User } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { trackConfirmedPurchase } from '../lib/analytics';
import { formatLagosDate, formatNgn, ORDER_STATUS_LABELS, type OrderStatus } from '../shared/types';
import { NigerianAddressForm, type NigerianAddressInput } from './NigerianAddressForm';

interface CustomerAccountProps {
  user: any;
  onRefreshUser: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onTrackOrder: (orderNumber: string) => void;
  onSelectProduct: (slug: string) => void;
}

export const CustomerAccountView: React.FC<CustomerAccountProps> = ({
  user,
  onRefreshUser,
  onSignOut,
  onTrackOrder,
  onSelectProduct,
}) => {
  const [tab, setTab] = useState<'orders' | 'addresses' | 'wishlist' | 'profile' | 'support'>('orders');
  const [orders, setOrders] = useState<any[]>([]);
  const [addresses, setAddresses] = useState<any[]>([]);
  const [wishlist, setWishlist] = useState<any[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Profile form
  const [name, setName] = useState(user?.name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [notifyOrderUpdates, setNotifyOrderUpdates] = useState(Boolean(user?.notifyOrderUpdates));
  const [notifyPromotions, setNotifyPromotions] = useState(Boolean(user?.notifyPromotions));
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // New Address form
  const [showAddAddr, setShowAddAddr] = useState(false);
  const [newAddr, setNewAddr] = useState<NigerianAddressInput>({
    fullName: user?.name || '',
    email: user?.email || '',
    phone: user?.phone || '',
    state: '',
    lga: '',
    city: '',
    streetAddress: '',
    additionalInstructions: '',
  });

  // Support ticket
  const [subject, setSubject] = useState('');
  const [orderRef, setOrderRef] = useState('');
  const [ticketMessage, setTicketMessage] = useState('');

  // Inline cancellation modal state (no browser prompt)
  const [cancelOrderNum, setCancelOrderNum] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const loadData = async () => {
    try {
      const [ordRes, addrRes, wishRes, supRes] = await Promise.all([
        apiFetch<{ orders: any[] }>('/api/orders'),
        apiFetch<{ addresses: any[] }>('/api/addresses'),
        apiFetch<{ items: any[] }>('/api/wishlist'),
        apiFetch<{ tickets: any[] }>('/api/support'),
      ]);
      setOrders(ordRes.orders || []);
      for (const ord of ordRes.orders || []) {
        if (ord.payment_status === 'payment_confirmed') {
          trackConfirmedPurchase({
            orderNumber: ord.order_number,
            paymentStatus: ord.payment_status,
            totalKobo: Number(ord.total_kobo || 0),
            deliveryFeeKobo: Number(ord.delivery_fee_kobo || 0),
          });
        }
      }
      setAddresses(addrRes.addresses || []);
      setWishlist(wishRes.items || []);
      setTickets(supRes.tickets || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (user) loadData();
  }, [user?.id]);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    try {
      await apiFetch('/api/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name, phone, notifyOrderUpdates, notifyPromotions }),
      });
      await onRefreshUser();
      setMsg('Profile and notification preferences updated.');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setMsg('Password updated and other sessions revoked.');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const saveAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await apiFetch('/api/addresses', {
        method: 'POST',
        body: JSON.stringify({ ...newAddr, isDefault: addresses.length === 0 }),
      });
      setShowAddAddr(false);
      await loadData();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const setDefaultAddress = async (addressId: string) => {
    await apiFetch(`/api/addresses/${addressId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isDefault: true }),
    });
    await loadData();
  };

  const deleteAddress = async (addressId: string) => {
    await apiFetch(`/api/addresses/${addressId}`, { method: 'DELETE' });
    await loadData();
  };

  const removeWishlist = async (productId: string) => {
    await apiFetch(`/api/wishlist/${productId}`, { method: 'DELETE' });
    await loadData();
  };

  const submitCancelRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelOrderNum || cancelReason.trim().length < 4) {
      setErr('Please enter at least 4 characters explaining why you want to cancel.');
      return;
    }
    setErr(null);
    try {
      await apiFetch(`/api/orders/${cancelOrderNum}/cancel-request`, {
        method: 'POST',
        body: JSON.stringify({ reason: cancelReason.trim() }),
      });
      setCancelOrderNum(null);
      setCancelReason('');
      setMsg(`Cancellation request submitted for ${cancelOrderNum}.`);
      await loadData();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const submitTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/support', {
      method: 'POST',
      body: JSON.stringify({ subject, orderNumber: orderRef, message: ticketMessage }),
    });
    setSubject('');
    setOrderRef('');
    setTicketMessage('');
    await loadData();
    setMsg('Support ticket submitted.');
  };

  const downloadMyData = async () => {
    const data = await apiFetch('/api/me/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sellora-account-export.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const requestDeletion = async () => {
    await apiFetch('/api/me/privacy-request', {
      method: 'POST',
      body: JSON.stringify({ requestType: 'deletion', notes: 'Customer requested account deletion.' }),
    });
    setMsg('Account deletion request recorded for administrator processing.');
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 pb-24 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-[#172554] text-[#B7F36B] flex items-center justify-center font-bold text-lg">
            {user.name?.[0]?.toUpperCase() || 'S'}
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#172554]">{user.name}</h1>
            <p className="text-xs text-slate-500">{user.email}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          <LogOut className="w-3.5 h-3.5" /> Sign Out
        </button>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 p-1 bg-white border border-slate-200 rounded-xl w-fit">
        {[
          { id: 'orders', label: 'Orders', icon: Package },
          { id: 'addresses', label: 'Nigerian Addresses', icon: MapPin },
          { id: 'wishlist', label: 'Wishlist', icon: Heart },
          { id: 'profile', label: 'Profile & Privacy', icon: User },
          { id: 'support', label: 'Support', icon: Package },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as any)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              tab === t.id
                ? 'bg-[#172554] text-[#B7F36B]'
                : 'text-slate-600 hover:text-[#172554]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && (
        <div className="rounded-xl bg-[#B7F36B]/30 border border-[#172554]/20 px-4 py-3 text-xs font-semibold text-[#172554]">
          {msg}
        </div>
      )}
      {err && (
        <div className="rounded-xl bg-[#F47B68]/15 border border-[#F47B68]/40 px-4 py-3 text-xs font-semibold text-[#9A2E1E]">
          {err}
        </div>
      )}

      {tab === 'orders' && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {orders.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              You have not placed any orders yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {orders.map((o) => (
                <div
                  key={o.order_id}
                  className="p-5 flex flex-wrap items-center justify-between gap-4 hover:bg-[#F5F7F4]/60"
                >
                  <div>
                    <div className="font-mono-tabular text-sm font-bold text-[#172554]">
                      {o.order_number}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {formatLagosDate(o.created_at)} ·{' '}
                      {ORDER_STATUS_LABELS[o.order_status as OrderStatus] || o.order_status}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-[#172554] tabular-nums">
                      {formatNgn(o.total_kobo)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onTrackOrder(o.order_number)}
                      className="rounded-lg bg-[#172554] px-3 py-1.5 text-xs font-semibold text-[#B7F36B]"
                    >
                      Track & Pay
                    </button>
                    {!['delivered', 'cancelled', 'refunded'].includes(o.order_status) && (
                      <button
                        type="button"
                        onClick={() => {
                          setCancelOrderNum(o.order_number);
                          setCancelReason('');
                        }}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-[#9A2E1E]"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'addresses' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-base font-bold text-[#172554]">Saved Delivery Addresses</h2>
            <button
              type="button"
              onClick={() => setShowAddAddr((s) => !s)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#172554] px-3.5 py-2 text-xs font-bold text-[#B7F36B]"
            >
              <Plus className="w-3.5 h-3.5" /> Add Address
            </button>
          </div>

          {showAddAddr && (
            <form
              onSubmit={saveAddress}
              className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4"
            >
              <NigerianAddressForm value={newAddr} onChange={setNewAddr} />
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="rounded-lg bg-[#172554] px-4 py-2 text-xs font-bold text-[#B7F36B]"
                >
                  Save Address
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddAddr(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {addresses.map((a) => (
              <div
                key={a.address_id}
                className="bg-white rounded-2xl border border-slate-200 p-5 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-[#172554]">
                    {a.full_name} {a.is_default ? '· Default' : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteAddress(a.address_id)}
                    className="text-slate-400 hover:text-[#F47B68]"
                    aria-label="Delete address"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-xs text-slate-600">
                  {a.street_address}, {a.city}
                </p>
                <p className="text-xs text-slate-500">
                  {a.lga}, {a.state} · {a.phone}
                </p>
                {!a.is_default && (
                  <button
                    type="button"
                    onClick={() => setDefaultAddress(a.address_id)}
                    className="text-xs font-semibold text-[#172554] underline pt-1"
                  >
                    Set as default
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'wishlist' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          {wishlist.length === 0 ? (
            <div className="sm:col-span-3 bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-500">
              Your wishlist is empty.
            </div>
          ) : (
            wishlist.map((w) => (
              <div
                key={w.wishlist_id}
                className="bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-col"
              >
                <button
                  type="button"
                  onClick={() => onSelectProduct(w.slug)}
                  className="aspect-[4/3] bg-[#F5F7F4]"
                >
                  {w.media?.[0] && (
                    <img src={w.media[0]} alt={w.name} className="w-full h-full object-cover" />
                  )}
                </button>
                <div className="p-4 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-[#172554]">{w.name}</div>
                    <div className="text-xs font-bold text-slate-700 tabular-nums">
                      {formatNgn(w.sale_price_kobo ?? w.price_kobo)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeWishlist(w.product_id)}
                    className="text-xs text-slate-500 hover:text-[#F47B68]"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'profile' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form onSubmit={saveProfile} className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-base font-bold text-[#172554]">Profile & Notifications</h2>
            <div>
              <label className="block text-xs font-semibold mb-1">Full Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Phone Number</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={notifyOrderUpdates}
                onChange={(e) => setNotifyOrderUpdates(e.target.checked)}
              />
              Receive transactional order status emails
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={notifyPromotions}
                onChange={(e) => setNotifyPromotions(e.target.checked)}
              />
              Receive store updates and promotions
            </label>
            <button
              type="submit"
              className="rounded-lg bg-[#172554] px-4 py-2 text-xs font-bold text-[#B7F36B]"
            >
              Save Profile
            </button>
          </form>

          <div className="space-y-6">
            <form onSubmit={changePassword} className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <h2 className="text-base font-bold text-[#172554]">Security & Password</h2>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Current password"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New password (min 8 chars)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="rounded-lg border border-[#172554] px-4 py-2 text-xs font-bold text-[#172554] hover:bg-[#172554] hover:text-[#B7F36B]"
              >
                Update Password & Revoke Other Sessions
              </button>
            </form>

            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-3">
              <h2 className="text-base font-bold text-[#172554]">Personal Information & Privacy</h2>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={downloadMyData}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-semibold text-[#1E293B]"
                >
                  <Download className="w-3.5 h-3.5" /> Export My Data
                </button>
                <button
                  type="button"
                  onClick={requestDeletion}
                  className="rounded-lg border border-[#F47B68] px-3.5 py-2 text-xs font-semibold text-[#9A2E1E]"
                >
                  Request Account Deletion
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'support' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form onSubmit={submitTicket} className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-base font-bold text-[#172554]">Submit Support Request</h2>
            <input
              type="text"
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              type="text"
              value={orderRef}
              onChange={(e) => setOrderRef(e.target.value)}
              placeholder="Order Number (optional)"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <textarea
              required
              rows={4}
              value={ticketMessage}
              onChange={(e) => setTicketMessage(e.target.value)}
              placeholder="Describe how our team can help..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="rounded-lg bg-[#172554] px-4 py-2 text-xs font-bold text-[#B7F36B]"
            >
              Send Support Request
            </button>
          </form>

          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-base font-bold text-[#172554]">Your Support History</h2>
            {tickets.length === 0 ? (
              <p className="text-xs text-slate-500">No support tickets submitted yet.</p>
            ) : (
              <div className="space-y-3">
                {tickets.map((t) => (
                  <div key={t.id} className="rounded-xl border border-slate-200 p-4 text-xs space-y-1">
                    <div className="flex justify-between font-bold text-[#172554]">
                      <span>{t.subject}</span>
                      <span className="uppercase">{t.status}</span>
                    </div>
                    <p className="text-slate-600">{t.message}</p>
                    {t.admin_reply && (
                      <p className="pt-2 text-emerald-800 font-medium">
                        Store Reply: {t.admin_reply}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {cancelOrderNum && (
        <div className="fixed inset-0 z-50 bg-[#172554]/50 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={submitCancelRequest}
            className="bg-white rounded-2xl border border-slate-200 max-w-md w-full p-6 space-y-4 shadow-xl"
          >
            <h3 className="text-base font-bold text-[#172554]">
              Cancel Order {cancelOrderNum}
            </h3>
            <p className="text-xs text-slate-600">
              Tell our team why you would like to cancel this order. Our staff will review and confirm.
            </p>
            <textarea
              required
              minLength={4}
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Reason for cancellation..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCancelOrderNum(null);
                  setCancelReason('');
                }}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
              >
                Keep Order
              </button>
              <button
                type="submit"
                className="rounded-lg bg-[#172554] px-4 py-2 text-xs font-bold text-[#B7F36B]"
              >
                Submit Request
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
