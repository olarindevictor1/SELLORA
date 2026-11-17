export interface BatchStatement {
  sql: string;
  params?: unknown[];
}

export interface BatchResult {
  changes: number;
}

export interface SelloraDb {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  batch(statements: BatchStatement[]): Promise<BatchResult[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SelloraDb) => Promise<T>): Promise<T>;
  rawSqlite?: unknown;
}

export interface SelloraStorage {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
  list?(prefix: string): Promise<Array<{ key: string; uploadedAt: string }>>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = unknown>(): Promise<{ results: T[]; meta?: { changes?: number } }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface D1LikeDatabase {
  prepare(sql: string): D1PreparedStatementLike;
  exec(sql: string): Promise<unknown>;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<T[]>;
}

const KNOWN_DB_GUARD_CODES = [
  'INSUFFICIENT_STOCK',
  'COUPON_INACTIVE',
  'COUPON_NOT_STARTED',
  'COUPON_EXPIRED',
  'COUPON_LIMIT_EXCEEDED',
  'COUPON_INVALID',
  'DELIVERY_ZONE_UNAVAILABLE',
  'VARIANT_UNAVAILABLE',
  'PAYMENT_ALREADY_CONFIRMED',
  'PAYMENT_NOT_FOUND',
  'INVALID_PAYMENT_STATE',
  'CANNOT_REJECT_CONFIRMED_PAYMENT',
] as const;

export type KnownDbGuardCode = (typeof KNOWN_DB_GUARD_CODES)[number];

export function extractDbGuardCode(err: unknown): KnownDbGuardCode | null {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  for (const code of KNOWN_DB_GUARD_CODES) {
    if (msg.includes(code)) return code;
  }
  return null;
}

export function isUniqueConstraintError(err: unknown, columnHint?: string): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!/UNIQUE constraint failed/i.test(msg)) return false;
  return columnHint ? msg.includes(columnHint) : true;
}

export function isConstraintAbortError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    extractDbGuardCode(err) !== null ||
    /constraint failed|NOT NULL|CHECK constraint|FOREIGN KEY|UNIQUE constraint/i.test(msg)
  );
}

export function createD1Db(d1: D1LikeDatabase): SelloraDb {
  const self: SelloraDb = {
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const stmt = params.length > 0 ? d1.prepare(sql).bind(...params) : d1.prepare(sql);
      const res = await stmt.all<T>();
      return res.results ?? [];
    },
    async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
      const stmt = params.length > 0 ? d1.prepare(sql).bind(...params) : d1.prepare(sql);
      const row = await stmt.first<T>();
      return row ?? null;
    },
    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      const stmt = params.length > 0 ? d1.prepare(sql).bind(...params) : d1.prepare(sql);
      const res = await stmt.run();
      return { changes: res.meta?.changes ?? 0 };
    },
    async batch(statements: BatchStatement[]): Promise<BatchResult[]> {
      if (statements.length === 0) return [];
      const prepared = statements.map((s) => {
        const params = s.params ?? [];
        return params.length > 0 ? d1.prepare(s.sql).bind(...params) : d1.prepare(s.sql);
      });
      const results = (await d1.batch<{ meta?: { changes?: number } }>(prepared)) ?? [];
      return results.map((r) => ({ changes: r?.meta?.changes ?? 0 }));
    },
    async exec(sql: string): Promise<void> {
      await d1.exec(sql);
    },
    async transaction<T>(fn: (tx: SelloraDb) => Promise<T>): Promise<T> {
      // Legacy fallback: callers performing multi-write mutations should use db.batch().
      return fn(self);
    },
  };
  return self;
}

export interface R2LikeBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
  list?(options?: { prefix?: string; cursor?: string }): Promise<{
    objects: Array<{ key: string; uploaded?: Date | string }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

export function createR2Storage(bucket: R2LikeBucket): SelloraStorage {
  return {
    async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
      await bucket.put(key, data, { httpMetadata: { contentType } });
    },
    async get(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
      const obj = await bucket.get(key);
      if (!obj) return null;
      const ab = await obj.arrayBuffer();
      return {
        data: new Uint8Array(ab),
        contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
      };
    },
    async delete(key: string): Promise<void> {
      await bucket.delete(key);
    },
    async list(prefix: string): Promise<Array<{ key: string; uploadedAt: string }>> {
      if (!bucket.list) return [];
      const out: Array<{ key: string; uploadedAt: string }> = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        for (const obj of page.objects ?? []) {
          const uploadedAt =
            obj.uploaded instanceof Date
              ? obj.uploaded.toISOString()
              : typeof obj.uploaded === 'string'
                ? obj.uploaded
                : new Date(0).toISOString();
          out.push({ key: obj.key, uploadedAt });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}
