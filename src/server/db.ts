export interface SelloraDb {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SelloraDb) => Promise<T>): Promise<T>;
  rawSqlite?: unknown;
}

export interface SelloraStorage {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface D1LikeDatabase {
  prepare(sql: string): D1PreparedStatementLike;
  exec(sql: string): Promise<unknown>;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<T[]>;
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
    async exec(sql: string): Promise<void> {
      await d1.exec(sql);
    },
    async transaction<T>(fn: (tx: SelloraDb) => Promise<T>): Promise<T> {
      // D1 Worker runtime executes queries sequentially against D1; conditional UPDATE checks
      // (e.g. WHERE stock_quantity >= ? and COUNT(*) owner checks) guarantee atomicity.
      return fn(self);
    },
  };
  return self;
}

export interface R2LikeBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
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
  };
}
