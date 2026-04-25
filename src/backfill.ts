import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

import { logger } from "./logger.js";

export interface BackfillOptions {
  databaseUrl: string;
  migrationsDir: string;
  /** Schema name for the pgkit migrations table. Defaults to `migrator_internal`. */
  migrationSchema?: string;
  /** Source drizzle migrations table name. Defaults to `drizzle.__drizzle_migrations`. */
  drizzleMigrationsTable?: string;
}

/**
 * Backfills a database that was previously migrated with drizzle-kit so that
 * `@pgkit/migrator` sees the existing migrations as already applied.
 */
export async function backfillMigrations(opts: BackfillOptions): Promise<void> {
  const schema = opts.migrationSchema ?? "migrator_internal";
  const sourceTable =
    opts.drizzleMigrationsTable ?? "drizzle.__drizzle_migrations";

  const pool = new pg.Pool({ connectionString: opts.databaseUrl });

  try {
    await pool.query(
      `CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(schema)}`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${pg.escapeIdentifier(schema)}.migrations (
        name text primary key,
        content text not null,
        status text,
        date timestamptz not null default now()
      )`,
    );

    const migrationsDirectory = resolve(opts.migrationsDir);
    const files = await readdir(migrationsDirectory);

    for (const file of files) {
      if (!file.endsWith(".sql")) continue;
      const content = await readFile(resolve(migrationsDirectory, file), "utf8");
      logger.info(`Backfilling migration ${file}`);
      await pool.query(
        `insert into ${pg.escapeIdentifier(schema)}.migrations (name, content, status, date)
         select $1 as name, $2 as content, $3 as status, to_timestamp(d.created_at / 1000) as date
         from ${sourceTable} d
         on conflict do nothing`,
        [file, content, "executed"],
      );
    }
  } finally {
    await pool.end();
  }
}
