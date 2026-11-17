import { scrypt as nodeScrypt } from 'node:crypto';

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

export function generateRecoveryCode(): string {
  const seg = () => {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
  };
  return `SLR-REC-${seg()}-${seg()}-${seg()}`;
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

/**
 * Calibrated scrypt parameters supported natively in Node.js and Cloudflare Workers (`nodejs_compat`):
 * N = 16384 (2^14), r = 8, p = 1, dkLen = 64 bytes (~16 MiB RAM, <= 32 MiB maxmem ceiling).
 * Chosen over WebCrypto PBKDF2-SHA256 (capped at 100,000 iterations on Cloudflare Workers) for
 * memory-hard GPU/ASIC resistance while remaining safely within Worker CPU & 128 MiB isolate budgets.
 */
export const ADMIN_SEC_SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  dkLen: 64,
  maxmem: 32 * 1024 * 1024,
  saltBytes: 16,
  algorithmId: 'scrypt_N16384_r8_p1_dkLen64',
} as const;

function deriveScryptHex(
  password: string,
  saltHex: string,
  N: number,
  r: number,
  p: number,
  dkLen: number
): Promise<string> {
  const normalized = password.normalize('NFKC');
  return new Promise((resolve, reject) => {
    nodeScrypt(
      normalized,
      saltHex,
      dkLen,
      { N, r, p, maxmem: Math.max(32 * 1024 * 1024, 256 * N * r) },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey.toString('hex'));
      }
    );
  });
}

export async function hashAdminSecurityPassword(password: string): Promise<{
  encodedHash: string;
  algorithmId: string;
}> {
  const saltHex = randomHex(ADMIN_SEC_SCRYPT_PARAMS.saltBytes);
  const derivedHex = await deriveScryptHex(
    password,
    saltHex,
    ADMIN_SEC_SCRYPT_PARAMS.N,
    ADMIN_SEC_SCRYPT_PARAMS.r,
    ADMIN_SEC_SCRYPT_PARAMS.p,
    ADMIN_SEC_SCRYPT_PARAMS.dkLen
  );
  return {
    encodedHash: `scrypt$N=${ADMIN_SEC_SCRYPT_PARAMS.N}$r=${ADMIN_SEC_SCRYPT_PARAMS.r}$p=${ADMIN_SEC_SCRYPT_PARAMS.p}$dkLen=${ADMIN_SEC_SCRYPT_PARAMS.dkLen}$${saltHex}$${derivedHex}`,
    algorithmId: ADMIN_SEC_SCRYPT_PARAMS.algorithmId,
  };
}

export async function verifyAdminSecurityPassword(
  password: string,
  encodedHash: string
): Promise<boolean> {
  const parts = String(encodedHash || '').split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1].replace(/^N=/, ''));
  const r = Number(parts[2].replace(/^r=/, ''));
  const p = Number(parts[3].replace(/^p=/, ''));
  const dkLen = Number(parts[4].replace(/^dkLen=/, ''));
  const saltHex = parts[5];
  const expectedHex = parts[6];
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    !Number.isInteger(dkLen) ||
    N < 16384 ||
    r < 8 ||
    p < 1 ||
    dkLen < 32 ||
    !saltHex ||
    !expectedHex
  ) {
    return false;
  }
  const actualHex = await deriveScryptHex(password, saltHex, N, r, p, dkLen);
  return timingSafeEqualStr(actualHex, expectedHex);
}

