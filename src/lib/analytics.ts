import { resolveApiUrl } from './api';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const CONSENT_STORAGE_KEY = 'sellora_analytics_consent';
const SESSION_STORAGE_KEY = 'sellora_anon_session_id';

let initializedMeasurementId = '';
let lastTrackedPagePath = '';

export type AnalyticsConsent = 'granted' | 'denied' | null;

export function getAnalyticsConsent(): AnalyticsConsent {
  if (typeof window === 'undefined') return null;
  try {
    const val = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return val === 'granted' || val === 'denied' ? val : null;
  } catch {
    return null;
  }
}

export function setAnalyticsConsent(consent: 'granted' | 'denied', measurementId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, consent);
  } catch {
    // ignore storage limits
  }
  if (consent === 'granted' && measurementId) {
    initGa4(measurementId);
  } else if (consent === 'denied' && window.gtag) {
    window.gtag('consent', 'update', { analytics_storage: 'denied' });
  }
}

function getAnonSessionKey(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    let key = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!key) {
      key = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, key);
    }
    return key;
  } catch {
    return 'anon_fallback';
  }
}

export function resolveGaMeasurementId(dbMeasurementId?: string): string {
  const envId = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GA_MEASUREMENT_ID
    ? import.meta.env.VITE_GA_MEASUREMENT_ID
    : ''
  ).trim();
  const cfgId = (dbMeasurementId || '').trim();
  const id = cfgId || envId;
  return /^G-[A-Z0-9]{4,}$/i.test(id) && !/^G-X+$/i.test(id) ? id : '';
}

export function initGa4(measurementId?: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const resolvedId = resolveGaMeasurementId(measurementId);
  if (!resolvedId) return;
  if (getAnalyticsConsent() === 'denied') return;
  if (initializedMeasurementId === resolvedId) return;

  initializedMeasurementId = resolvedId;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag(...args: unknown[]) {
    window.dataLayer!.push(args);
  };
  window.gtag('js', new Date());
  window.gtag('config', resolvedId, {
    send_page_view: false,
    anonymize_ip: true,
    allow_google_signals: false,
  });

  if (!document.getElementById('sellora-ga4-script')) {
    const s = document.createElement('script');
    s.id = 'sellora-ga4-script';
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(resolvedId)}`;
    s.onerror = () => {
      // Fail quietly if analytics script is blocked by network/adblocker
    };
    document.head.appendChild(s);
  }
}

function postFirstPartyEvent(payload: {
  eventName: 'page_view' | 'view_item' | 'add_to_cart' | 'begin_checkout';
  path: string;
  productId?: string;
  valueKobo?: number;
}) {
  if (typeof window === 'undefined') return;
  // Never track internal admin paths in public storefront traffic stats
  if (payload.path.startsWith('/admin')) return;
  if (getAnalyticsConsent() === 'denied') return;

  const cleanPath = payload.path.split('?')[0] || '/';
  fetch(resolveApiUrl('/api/analytics/collect'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      sessionKey: getAnonSessionKey(),
      eventName: payload.eventName,
      path: cleanPath,
      referrer: document.referrer && !document.referrer.startsWith(window.location.origin)
        ? document.referrer
        : undefined,
      productId: payload.productId,
      valueKobo: payload.valueKobo,
    }),
  }).catch(() => {});
}

export function trackPageView(path: string, title: string, measurementId?: string): void {
  if (typeof window === 'undefined') return;
  const cleanPath = path.split('?')[0] || '/';
  if (cleanPath === lastTrackedPagePath) return;
  lastTrackedPagePath = cleanPath;

  initGa4(measurementId);

  if (window.gtag && initializedMeasurementId && getAnalyticsConsent() !== 'denied') {
    window.gtag('event', 'page_view', {
      page_title: title,
      page_path: cleanPath,
      page_location: `${window.location.origin}${cleanPath}`,
    });
  }

  postFirstPartyEvent({ eventName: 'page_view', path: cleanPath });
}

export function trackProductView(product: {
  id: string;
  name: string;
  sku: string;
  category_name?: string;
  priceKobo: number;
  slug: string;
}): void {
  if (typeof window === 'undefined') return;
  const valueNaira = Number((product.priceKobo / 100).toFixed(2));
  if (window.gtag && initializedMeasurementId && getAnalyticsConsent() !== 'denied') {
    window.gtag('event', 'view_item', {
      currency: 'NGN',
      value: valueNaira,
      items: [
        {
          item_id: product.sku || product.id,
          item_name: product.name,
          item_category: product.category_name || 'SELLORA',
          price: valueNaira,
        },
      ],
    });
  }
  postFirstPartyEvent({
    eventName: 'view_item',
    path: `/product/${product.slug}`,
    productId: product.id,
    valueKobo: product.priceKobo,
  });
}

export function trackAddToCart(item: {
  productId: string;
  name: string;
  sku: string;
  variantName: string;
  unitPriceKobo: number;
  quantity: number;
}): void {
  if (typeof window === 'undefined') return;
  const unitNaira = Number((item.unitPriceKobo / 100).toFixed(2));
  const valueNaira = Number(((item.unitPriceKobo * item.quantity) / 100).toFixed(2));
  if (window.gtag && initializedMeasurementId && getAnalyticsConsent() !== 'denied') {
    window.gtag('event', 'add_to_cart', {
      currency: 'NGN',
      value: valueNaira,
      items: [
        {
          item_id: item.sku || item.productId,
          item_name: item.name,
          item_variant: item.variantName,
          price: unitNaira,
          quantity: item.quantity,
        },
      ],
    });
  }
  postFirstPartyEvent({
    eventName: 'add_to_cart',
    path: window.location.pathname || '/',
    productId: item.productId,
    valueKobo: item.unitPriceKobo * item.quantity,
  });
}

export function trackBeginCheckout(
  items: Array<{ sku: string; productId: string; productName: string; variantName: string; unitPriceKobo: number; quantity: number }>,
  subtotalKobo: number
): void {
  if (typeof window === 'undefined') return;
  const valueNaira = Number((subtotalKobo / 100).toFixed(2));
  if (window.gtag && initializedMeasurementId && getAnalyticsConsent() !== 'denied') {
    window.gtag('event', 'begin_checkout', {
      currency: 'NGN',
      value: valueNaira,
      items: items.map((i) => ({
        item_id: i.sku || i.productId,
        item_name: i.productName,
        item_variant: i.variantName,
        price: Number((i.unitPriceKobo / 100).toFixed(2)),
        quantity: i.quantity,
      })),
    });
  }
  postFirstPartyEvent({
    eventName: 'begin_checkout',
    path: '/checkout',
    valueKobo: subtotalKobo,
  });
}

/**
 * Only fires GA4 `purchase` after server-side payment confirmation (`payment_confirmed`).
 * Unverified bank transfers (`pending_payment`, `payment_under_review`) are never recorded as purchases.
 */
export function trackConfirmedPurchase(order: {
  orderNumber: string;
  paymentStatus: string;
  totalKobo: number;
  deliveryFeeKobo?: number;
  items?: Array<{
    sku?: string;
    product_id?: string;
    product_name: string;
    variant_name?: string;
    unit_price_kobo: number;
    quantity: number;
  }>;
}): void {
  if (typeof window === 'undefined') return;
  if (order.paymentStatus !== 'payment_confirmed') return;

  const dedupeKey = `sellora_ga_purchased_${order.orderNumber}`;
  try {
    if (window.localStorage.getItem(dedupeKey)) return;
  } catch {
    // proceed cleanly
  }

  if (window.gtag && initializedMeasurementId && getAnalyticsConsent() !== 'denied') {
    window.gtag('event', 'purchase', {
      transaction_id: order.orderNumber,
      currency: 'NGN',
      value: Number((order.totalKobo / 100).toFixed(2)),
      shipping: Number(((order.deliveryFeeKobo || 0) / 100).toFixed(2)),
      items: (order.items || []).map((it) => ({
        item_id: it.sku || it.product_id || it.product_name,
        item_name: it.product_name,
        item_variant: it.variant_name || undefined,
        price: Number((it.unit_price_kobo / 100).toFixed(2)),
        quantity: it.quantity,
      })),
    });
    try {
      window.localStorage.setItem(dedupeKey, new Date().toISOString());
    } catch {
      // ignore storage limits
    }
  }
}
