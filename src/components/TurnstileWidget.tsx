import React, { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          theme?: 'light' | 'dark' | 'auto';
          callback: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: () => void;
        }
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

let turnstileScriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]'
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load Turnstile')), {
        once: true,
      });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      turnstileScriptPromise = null;
      reject(new Error('Unable to load Cloudflare Turnstile security widget.'));
    };
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
}

interface TurnstileWidgetProps {
  siteKey?: string | null;
  resetKey?: number;
  theme?: 'light' | 'dark' | 'auto';
  onToken: (token: string | null) => void;
  onError?: (message: string) => void;
}

export const TurnstileWidget: React.FC<TurnstileWidgetProps> = ({
  siteKey,
  resetKey = 0,
  theme = 'light',
  onToken,
  onError,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  onTokenRef.current = onToken;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        if (widgetIdRef.current) {
          try {
            window.turnstile.remove(widgetIdRef.current);
          } catch {
            // ignore stale widget cleanup error
          }
          widgetIdRef.current = null;
        }
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          callback: (token: string) => {
            onTokenRef.current(token);
          },
          'expired-callback': () => {
            onTokenRef.current(null);
          },
          'error-callback': () => {
            onTokenRef.current(null);
            onErrorRef.current?.('Security check encountered an error. Please retry.');
          },
        });
      })
      .catch((err) => {
        if (!cancelled) {
          onTokenRef.current(null);
          onErrorRef.current?.(
            err instanceof Error ? err.message : 'Unable to initialize Turnstile check.'
          );
        }
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore cleanup failure
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, theme]);

  useEffect(() => {
    if (!siteKey || resetKey === 0) return;
    onTokenRef.current(null);
    if (widgetIdRef.current && window.turnstile) {
      try {
        window.turnstile.reset(widgetIdRef.current);
      } catch {
        // ignore reset error
      }
    }
  }, [resetKey, siteKey]);

  if (!siteKey) return null;

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold text-slate-500">Security Verification</div>
      <div ref={containerRef} className="min-h-[65px] flex items-center" />
    </div>
  );
};
