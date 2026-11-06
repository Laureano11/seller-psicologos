import { readFileSync } from 'node:fs';
import pg from 'pg';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function createPgDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url });
  return {
    async query(sql, params) {
      const r = await pool.query(sql, params as any[]);
      return r.rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

export async function createMemoryDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite();
  await lite.waitReady;
  return {
    async query(sql, params) {
      const r = await lite.query(sql, params as any[]);
      return r.rows as any[];
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    close: () => lite.close(),
  };
}

export async function migrate(db: Db): Promise<void> {
  await db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}
