import React, { useState } from 'react';
import { NIGERIAN_STATES_LGAS, getLgasForState } from '../shared/nigeria-locations';

export interface NigerianAddressInput {
  fullName: string;
  email: string;
  phone: string;
  state: string;
  lga: string;
  city: string;
  streetAddress: string;
  additionalInstructions: string;
}

interface Props {
  value: NigerianAddressInput;
  onChange: (next: NigerianAddressInput) => void;
  showContactFields?: boolean;
}

export const NigerianAddressForm: React.FC<Props> = ({
  value,
  onChange,
  showContactFields = true,
}) => {
  const [manualLga, setManualLga] = useState(false);
  const lgas = value.state ? getLgasForState(value.state) : [];

  const update = (patch: Partial<NigerianAddressInput>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <div className="space-y-4">
      {showContactFields && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-[#1E293B] mb-1.5">
              Full Name <span className="text-[#F47B68]">*</span>
            </label>
            <input
              type="text"
              required
              value={value.fullName}
              onChange={(e) => update({ fullName: e.target.value })}
              placeholder="e.g. Chinedu Okafor"
              className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#1E293B] focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#1E293B] mb-1.5">
              Email Address <span className="text-[#F47B68]">*</span>
            </label>
            <input
              type="email"
              required
              value={value.email}
              onChange={(e) => update({ email: e.target.value })}
              placeholder="name@example.com"
              className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#1E293B] focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#1E293B] mb-1.5">
              Phone Number (Nigeria) <span className="text-[#F47B68]">*</span>
            </label>
            <input
              type="tel"
              required
              value={value.phone}
              onChange={(e) => update({ phone: e.target.value })}
              placeholder="e.g. 0803 123 4567"
              className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#1E293B] focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
            />
          </div>
        </div>
      )}

      {/* State -> LGA -> City/Town -> Street Address */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-[#1E293B] mb-1.5">
            State <span className="text-[#F47B68]">*</span>
          </label>
          <select
            required
            value={value.state}
            onChange={(e) => {
              const nextState = e.target.value;
              const nextLgas = getLgasForState(nextState);
              update({
                state: nextState,
                lga: nextLgas.includes(value.lga) ? value.lga : '',
              });
              setManualLga(false);
            }}
            className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#1E293B] focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
          >
            <option value="">Select Nigerian State</option>
            {NIGERIAN_STATES_LGAS.map((s) => (
              <option key={s.state} value={s.state}>
                {s.state}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-semibold text-[#1E293B]">
              Local Government Area (LGA) <span className="text-[#F47B68]">*</span>
            </label>
            {value.state && (
              <button
                type="button"
                onClick={() => setManualLga((m) => !m)}
                className="text-[11px] font-medium text-[#172554] underline hover:opacity-80"
              >
                {manualLga ? 'Use LGA list' : 'Enter manually'}
              </button>
            )}
          </div>
          {!manualLga && lgas.length > 0 ? (
            <select
              required
              value={value.lga}
              onChange={(e) => update({ lga: e.target.value })}
              className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#1E293B] focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
            >
              <option value="">Select LGA in {value.state}</option>
              {lgas.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              required
              value={value.lga}
              onChange={(e) => update({ lga: e.target.value })}
              placeholder={value.state ? `Enter LGA in ${value.state}` : 'Select a state first'}
              disabled={!value.state}
              className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#1E293B] disabled:bg-slate-100 focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
            />
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#1E293B] mb-1.5">
            City / Town <span className="text-[#F47B68]">*</span>
          </label>
          <input
            type="text"
            required
            value={value.city}
            onChange={(e) => update({ city: e.target.value })}
            placeholder="e.g. Lekki Phase 1, Wuse II, GRA"
            className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#1E293B] focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#1E293B] mb-1.5">
            Street Address / House Number <span className="text-[#F47B68]">*</span>
          </label>
          <input
            type="text"
            required
            value={value.streetAddress}
            onChange={(e) => update({ streetAddress: e.target.value })}
            placeholder="e.g. 14 Admiralty Way"
            className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#1E293B] focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-[#1E293B] mb-1.5">
            Additional Delivery Instructions
          </label>
          <input
            type="text"
            value={value.additionalInstructions}
            onChange={(e) => update({ additionalInstructions: e.target.value })}
            placeholder="Nearest landmark, gate code, or preferred delivery hours"
            className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-[#1E293B] focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
          />
        </div>
      </div>
    </div>
  );
};
