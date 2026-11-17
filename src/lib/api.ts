const CART_TOKEN_KEY = 'sellora_cart_token';

export function getApiBaseUrl(override?: string): string {
  const raw = (
    override !== undefined
      ? override
      : typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL
        ? (import.meta as { env?: Record<string, string | undefined> }).env!.VITE_API_BASE_URL || ''
        : ''
  ).trim();
  if (!raw || raw.includes('your-sellora-domain') || raw.includes('REPLACE_WITH')) {
    return '';
  }
  return raw.replace(/\/+$/, '');
}

export function resolveApiUrl(path: string, baseOverride?: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const base = getApiBaseUrl(baseOverride);
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

export function resolveMediaUrl(url?: string | null, baseOverride?: string): string {
  const raw = (url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/api/')) {
    return resolveApiUrl(raw, baseOverride);
  }
  return raw;
}

export function getCartToken(): string {
  let token = localStorage.getItem(CART_TOKEN_KEY);
  if (!token) {
    token = 'cart_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(CART_TOKEN_KEY, token);
  }
  return token;
}

export async function apiFetch<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('x-cart-token', getCartToken());

  const res = await fetch(resolveApiUrl(path), {
    ...options,
    headers,
    credentials: 'include',
  });

  const text = await res.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const baseMsg = data?.error || data?.message || `Request failed (${res.status})`;
    const refSuffix = data?.referenceId ? ` (Reference: ${data.referenceId})` : '';
    throw new Error(`${baseMsg}${refSuffix}`);
  }

  return data as T;
}
