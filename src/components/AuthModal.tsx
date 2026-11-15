import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { SelloraLogo } from './SelloraLogo';
import { TurnstileWidget } from './TurnstileWidget';

interface AuthModalProps {
  initialMode?: 'signin' | 'signup' | 'forgot' | 'reset';
  resetToken?: string | null;
  googleOAuthEnabled?: boolean;
  turnstileSiteKey?: string | null;
  initialError?: string | null;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
}

const GoogleIcon: React.FC = () => (
  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
    />
    <path
      fill="#FBBC05"
      d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
    />
    <path
      fill="#EA4335"
      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
    />
  </svg>
);

export const AuthModal: React.FC<AuthModalProps> = ({
  initialMode = 'signin',
  resetToken = null,
  googleOAuthEnabled = false,
  turnstileSiteKey = null,
  initialError = null,
  onClose,
  onSuccess,
}) => {
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot' | 'reset'>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    if (initialError) setError(initialError);
  }, [initialError]);

  const resetTurnstile = () => {
    setTurnstileToken(null);
    setTurnstileResetKey((k) => k + 1);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (turnstileSiteKey && mode !== 'reset' && !turnstileToken) {
      setError('Please complete the Cloudflare Turnstile security verification check.');
      return;
    }

    setLoading(true);
    const extraHeaders: Record<string, string> = turnstileToken
      ? { 'x-turnstile-token': turnstileToken }
      : {};

    try {
      if (mode === 'signin') {
        await apiFetch('/api/auth/sign-in/email', {
          method: 'POST',
          headers: extraHeaders,
          body: JSON.stringify({
            email: email.trim(),
            password,
            turnstileToken: turnstileToken || undefined,
          }),
        });
        await onSuccess();
        onClose();
      } else if (mode === 'signup') {
        await apiFetch('/api/auth/sign-up/email', {
          method: 'POST',
          headers: extraHeaders,
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim(),
            password,
            phone: phone.trim() || undefined,
            turnstileToken: turnstileToken || undefined,
          }),
        });
        await onSuccess();
        onClose();
      } else if (mode === 'forgot') {
        await apiFetch('/api/auth/request-password-reset', {
          method: 'POST',
          headers: extraHeaders,
          body: JSON.stringify({
            email: email.trim(),
            redirectTo: `${window.location.origin}/?auth_mode=reset`,
            turnstileToken: turnstileToken || undefined,
          }),
        });
        setNotice(
          'If an account exists for that email, a password reset link has been queued via Brevo.'
        );
        resetTurnstile();
      } else if (mode === 'reset') {
        if (!resetToken) {
          throw new Error('Password reset token is missing or expired.');
        }
        if (password !== confirmPassword) {
          throw new Error('Passwords do not match.');
        }
        await apiFetch('/api/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({
            newPassword: password,
            token: resetToken,
          }),
        });
        setPassword('');
        setConfirmPassword('');
        setMode('signin');
        setNotice('Password updated successfully. You can now sign in with your email and password.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
      resetTurnstile();
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    if (!googleOAuthEnabled) return;
    setError(null);
    setNotice(null);
    setGoogleLoading(true);

    const isIframe = (() => {
      try {
        return window.self !== window.top;
      } catch {
        return true;
      }
    })();

    const callbackURL = isIframe
      ? `${window.location.origin}/api/auth/complete`
      : window.location.origin + window.location.pathname;

    try {
      const res = await apiFetch<{ url?: string }>('/api/auth/sign-in/social', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'google',
          callbackURL,
          errorCallbackURL: `${window.location.origin}/?auth_error=oauth_cancelled`,
        }),
      });
      if (!res.url) {
        throw new Error('Google sign-in redirect URL was not returned by server.');
      }

      if (!isIframe) {
        window.location.href = res.url;
        return;
      }

      const width = 520;
      const height = 640;
      const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
      const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
      const popup = window.open(
        res.url,
        'sellora_google_oauth',
        `width=${width},height=${height},left=${left},top=${top},popup=yes,noopener=no`
      );

      if (!popup) {
        setGoogleLoading(false);
        setError(
          'Your browser blocked the Google Sign-In popup. Allow popups for this site or open SELLORA in a top-level tab.'
        );
        return;
      }

      let finished = false;
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        window.clearInterval(pollTimer);
      };

      const completeAuth = async () => {
        if (finished) return;
        finished = true;
        cleanup();
        setGoogleLoading(false);
        await onSuccess();
        onClose();
      };

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'SELLORA_OAUTH_COMPLETE') {
          completeAuth().catch(() => {});
        }
      };

      window.addEventListener('message', onMessage);
      const pollTimer = window.setInterval(() => {
        if (popup.closed) {
          completeAuth().catch(() => {});
        }
      }, 450);
    } catch (err) {
      setGoogleLoading(false);
      setError(err instanceof Error ? err.message : 'Google sign-in unavailable');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#172554]/50 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-[#F5F7F4]">
          <SelloraLogo size="sm" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200/70 hover:text-slate-900"
            aria-label="Close authentication modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6">
          {mode !== 'reset' && (
            <div className="flex items-center gap-1 p-1 bg-[#F5F7F4] rounded-lg mb-5">
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setError(null);
                  setNotice(null);
                  resetTurnstile();
                }}
                className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  mode === 'signin'
                    ? 'bg-white text-[#172554] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('signup');
                  setError(null);
                  setNotice(null);
                  resetTurnstile();
                }}
                className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  mode === 'signup'
                    ? 'bg-white text-[#172554] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Create Account
              </button>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-lg bg-[#F47B68]/15 border border-[#F47B68]/40 px-3.5 py-2.5 text-xs font-medium text-[#9A2E1E]">
              {error}
            </div>
          )}
          {notice && (
            <div className="mb-4 rounded-lg bg-[#B7F36B]/25 border border-[#172554]/20 px-3.5 py-2.5 text-xs font-medium text-[#172554]">
              {notice}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <div>
                <label className="block text-xs font-semibold text-[#1E293B] mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter your full name"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
                />
              </div>
            )}

            {mode !== 'reset' && (
              <div>
                <label className="block text-xs font-semibold text-[#1E293B] mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
                />
              </div>
            )}

            {mode === 'signup' && (
              <div>
                <label className="block text-xs font-semibold text-[#1E293B] mb-1">
                  Phone Number (optional)
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="0803 000 0000"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
                />
              </div>
            )}

            {mode !== 'forgot' && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-[#1E293B]">
                    {mode === 'reset' ? 'New Password' : 'Password'}
                  </label>
                  {mode === 'signin' && (
                    <button
                      type="button"
                      onClick={() => {
                        setMode('forgot');
                        resetTurnstile();
                      }}
                      className="text-xs font-medium text-[#172554] hover:underline"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
                />
              </div>
            )}

            {mode === 'reset' && (
              <div>
                <label className="block text-xs font-semibold text-[#1E293B] mb-1">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-[#172554] focus:outline-none focus:ring-2 focus:ring-[#B7F36B]/60"
                />
              </div>
            )}

            {mode !== 'reset' && (
              <TurnstileWidget
                siteKey={turnstileSiteKey}
                resetKey={turnstileResetKey}
                onToken={setTurnstileToken}
                onError={(msg) => setError(msg)}
              />
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-[#172554] px-4 py-2.5 text-sm font-semibold text-[#B7F36B] hover:bg-[#1E3A8A] disabled:opacity-60 transition-colors"
            >
              {loading
                ? 'Please wait...'
                : mode === 'signin'
                  ? 'Sign In'
                  : mode === 'signup'
                    ? 'Create Customer Account'
                    : mode === 'reset'
                      ? 'Set New Password'
                      : 'Send Reset Link'}
            </button>
          </form>

          {(mode === 'forgot' || mode === 'reset') && (
            <button
              type="button"
              onClick={() => setMode('signin')}
              className="mt-3 w-full text-center text-xs font-medium text-slate-600 hover:text-[#172554]"
            >
              Back to Sign In
            </button>
          )}

          {(mode === 'signin' || mode === 'signup') && (
            <div className="mt-5 pt-4 border-t border-slate-200 space-y-2">
              <button
                type="button"
                disabled={!googleOAuthEnabled || googleLoading}
                onClick={() => handleGoogle()}
                className="w-full inline-flex items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-[#1E293B] hover:bg-[#F5F7F4] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                <GoogleIcon />
                <span>
                  {googleLoading ? 'Connecting to Google...' : 'Continue with Google'}
                </span>
              </button>
              {!googleOAuthEnabled && (
                <p className="text-[11px] text-center text-slate-500 leading-snug">
                  Google authentication is integrated and awaiting{' '}
                  <code>GOOGLE_CLIENT_ID</code> &amp; <code>GOOGLE_CLIENT_SECRET</code>.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
