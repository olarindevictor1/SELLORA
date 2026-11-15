import React, { useState } from 'react';
import { apiFetch } from '../lib/api';

interface StoreInfoProps {
  section: 'about' | 'contact' | 'faq' | 'policies' | 'privacy-policy' | 'terms';
  theme: any;
  user: any;
}

export const StoreInfoViews: React.FC<StoreInfoProps> = ({ section, theme, user }) => {
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [orderNumber, setOrderNumber] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  const handleSupport = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/support', {
      method: 'POST',
      body: JSON.stringify({
        customerName: name,
        customerEmail: email,
        orderNumber,
        subject,
        message,
      }),
    });
    setSent(true);
    setSubject('');
    setMessage('');
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 pb-24 space-y-8">
      {section === 'about' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 space-y-4">
          <h1 className="text-3xl font-bold text-[#172554]">About SELLORA</h1>
          <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-line">
            {theme?.aboutContent ||
              'SELLORA — Commerce without limits. A curated single-store ecommerce platform operating in Nigerian Naira (NGN).'}
          </p>
        </div>
      )}

      {section === 'faq' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 space-y-6">
          <h1 className="text-3xl font-bold text-[#172554]">Frequently Asked Questions</h1>
          <div className="divide-y divide-slate-200">
            {(theme?.faq || []).map((item: any, idx: number) => (
              <div key={idx} className="py-4 space-y-1.5">
                <h3 className="text-sm font-bold text-[#172554]">{item.q}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {section === 'policies' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 space-y-6">
          <h1 className="text-3xl font-bold text-[#172554]">Store Policies</h1>
          <div className="space-y-4 text-sm text-slate-600">
            <div>
              <h2 className="text-base font-bold text-[#172554] mb-1">Shipping & Delivery</h2>
              <p>{theme?.policies?.shipping}</p>
            </div>
            <div>
              <h2 className="text-base font-bold text-[#172554] mb-1">Returns & Refunds</h2>
              <p>{theme?.policies?.returns}</p>
            </div>
            <div>
              <h2 className="text-base font-bold text-[#172554] mb-1">Privacy & Data Protection</h2>
              <p>{theme?.policies?.privacy}</p>
            </div>
            <div>
              <h2 className="text-base font-bold text-[#172554] mb-1">Terms & Conditions</h2>
              <p>
                {theme?.policies?.terms ||
                  'All orders are priced in Nigerian Naira (NGN) and confirmed upon manual bank transfer verification.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {section === 'privacy-policy' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 space-y-5">
          <h1 className="text-3xl font-bold text-[#172554]">Privacy Policy</h1>
          <div className="space-y-3 text-sm text-slate-600 leading-relaxed">
            <p>
              {theme?.policies?.privacy ||
                'SELLORA collects only the account, shipping address, order, and payment verification information required to authenticate your account, verify bank transfers, and fulfil Nigerian deliveries.'}
            </p>
            <p>
              Uploaded bank transfer receipts are stored privately and reviewed strictly by authorized
              SELLORA store personnel. Customer emails, addresses, and payment evidence are never
              shared with external analytics services.
            </p>
          </div>
        </div>
      )}

      {section === 'terms' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 space-y-5">
          <h1 className="text-3xl font-bold text-[#172554]">Terms of Service</h1>
          <div className="space-y-3 text-sm text-slate-600 leading-relaxed">
            <p>
              {theme?.policies?.terms ||
                'All SELLORA storefront prices are quoted in Nigerian Naira (NGN). Orders placed via manual bank transfer remain pending until verified against confirmed funds.'}
            </p>
            <p>
              Delivery estimates depend on the selected Nigerian State and Local Government Area
              (LGA) delivery zone. Return or refund requests are processed according to our Store
              Policies.
            </p>
          </div>
        </div>
      )}

      {section === 'contact' && (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
          <div className="md:col-span-5 bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h1 className="text-2xl font-bold text-[#172554]">Contact & Support</h1>
            <p className="text-xs text-slate-600 leading-relaxed">
              Need help with an order, bank transfer verification, or Nigerian delivery zone? Submit
              a ticket and our support staff will respond.
            </p>
            <div className="text-xs space-y-2 pt-2 border-t border-slate-100 text-slate-700">
              {theme?.contactEmail && (
                <div>
                  Email: <strong>{theme.contactEmail}</strong>
                </div>
              )}
              {theme?.contactPhone && (
                <div>
                  Phone: <strong>{theme.contactPhone}</strong>
                </div>
              )}
              <div>
                Location: <strong>{theme?.contactAddress || 'Lagos, Nigeria'}</strong>
              </div>
            </div>
          </div>
          <form
            onSubmit={handleSupport}
            className="md:col-span-7 bg-white rounded-2xl border border-slate-200 p-6 space-y-4"
          >
            <h2 className="text-base font-bold text-[#172554]">Send a Support Request</h2>
            {sent && (
              <div className="rounded-lg bg-[#B7F36B]/30 px-3 py-2 text-xs font-semibold text-[#172554]">
                Your support request has been logged. Our team will follow up via email.
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your Name"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Your Email"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <input
                type="text"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="Order Number (optional)"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <textarea
              required
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="How can we assist you?"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="rounded-lg bg-[#172554] px-5 py-2.5 text-xs font-bold text-[#B7F36B]"
            >
              Submit Request
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
