// Postgres pool + migration runner.
//
// Migration strategy: tiny home-grown numbered-SQL runner. Drizzle ships
// migrations alongside this runner via `drizzle-kit generate`, but a
// hand-rolled runner keeps boot dependencies minimal and lets us read
// migration SQL verbatim for audit. Each file under gateway/migrations/
// must be named NNNN_*.sql and applied in numeric order.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import * as schema from './schema/index.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Pool = pg.Pool;

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// gateway/{src,dist}/db.ts → gateway/migrations/
const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

interface MigrationRow extends Record<string, unknown> {
  filename: string;
  applied_at: Date;
}

export async function runMigrations(
  db: Db,
  options: { migrationsDir?: string; log?: (msg: string) => void } = {},
): Promise<void> {
  const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const log = options.log ?? (() => {});

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const appliedResult = await db.execute<MigrationRow>(
    sql`SELECT filename, applied_at FROM _schema_migrations`,
  );
  const applied = new Set(appliedResult.rows.map((r) => r.filename));

  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const filename of files) {
    if (applied.has(filename)) {
      log(`migration ${filename}: already applied`);
      continue;
    }
    const path = resolve(dir, filename);
    const text = await readFile(path, 'utf8');
    log(`migration ${filename}: applying`);
    // Each migration runs in its own transaction.
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(text));
      await tx.execute(
        sql`INSERT INTO _schema_migrations (filename) VALUES (${filename})`,
      );
    });
    log(`migration ${filename}: applied`);
  }
}
