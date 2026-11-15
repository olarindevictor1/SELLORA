import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { SelloraDb, SelloraStorage } from './db';

export function createSqliteDb(dbPath: string, migrationsDir: string): SelloraDb {
  const dir = path.dirname(dbPath);
  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const wrap = (conn: Database.Database): SelloraDb => ({
    rawSqlite: conn,
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return conn.prepare(sql).all(...params) as T[];
    },
    async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
      const row = conn.prepare(sql).get(...params);
      return (row as T | undefined) ?? null;
    },
    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      const res = conn.prepare(sql).run(...params);
      return { changes: res.changes };
    },
    async exec(sql: string): Promise<void> {
      conn.exec(sql);
    },
    async transaction<T>(fn: (tx: SelloraDb) => Promise<T>): Promise<T> {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(wrap(conn));
        conn.exec('COMMIT');
        return result;
      } catch (err) {
        conn.exec('ROLLBACK');
        throw err;
      }
    },
  });

  if (fs.existsSync(migrationsDir)) {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`
    );

    const appliedRows = sqlite
      .prepare('SELECT version FROM schema_migrations')
      .all() as { version: string }[];
    const appliedSet = new Set(appliedRows.map((r) => r.version));

    for (const file of files) {
      if (!appliedSet.has(file)) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        sqlite.exec(sql);
        sqlite
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(file, new Date().toISOString());
      }
    }
  }

  return wrap(sqlite);
}

export function createLocalStorage(rootDir: string): SelloraStorage {
  fs.mkdirSync(rootDir, { recursive: true });
  return {
    async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
      const safeKey = key.replace(/\.\./g, '').replace(/^\/+/, '');
      const fullPath = path.join(rootDir, safeKey);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, data);
      fs.writeFileSync(fullPath + '.meta.json', JSON.stringify({ contentType }));
    },
    async get(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
      const safeKey = key.replace(/\.\./g, '').replace(/^\/+/, '');
      const fullPath = path.join(rootDir, safeKey);
      if (!fs.existsSync(fullPath)) return null;
      const data = fs.readFileSync(fullPath);
      let contentType = 'application/octet-stream';
      if (fs.existsSync(fullPath + '.meta.json')) {
        try {
          const meta = JSON.parse(fs.readFileSync(fullPath + '.meta.json', 'utf8'));
          if (meta.contentType) contentType = meta.contentType;
        } catch {
          // ignore
        }
      }
      return { data: new Uint8Array(data), contentType };
    },
    async delete(key: string): Promise<void> {
      const safeKey = key.replace(/\.\./g, '').replace(/^\/+/, '');
      const fullPath = path.join(rootDir, safeKey);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      if (fs.existsSync(fullPath + '.meta.json')) fs.unlinkSync(fullPath + '.meta.json');
    },
  };
}
