export function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Generates an unpredictable, non-sequential, high-entropy CSPRNG reference code
 * suitable for customer-facing error reporting (ERR-XXXXXXXX) and security events (SEC-XXXXXXXX).
 */
export function generateReferenceId(prefix: 'ERR' | 'SEC' = 'ERR', length = 8): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  }
  return `${prefix}-${out}`;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) {
    // Perform constant-length loop to reduce length-timing signal
    let diff = 1;
    for (let i = 0; i < ab.length; i++) {
      diff |= ab[i] ^ (bb[i % Math.max(1, bb.length)] ?? 0);
    }
    return diff === 0 && false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
