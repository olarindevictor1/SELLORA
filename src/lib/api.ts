const CART_TOKEN_KEY = 'sellora_cart_token';

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

  const res = await fetch(path, {
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
    throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  }

  return data as T;
}
