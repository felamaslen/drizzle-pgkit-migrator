import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

import { logger } from "./logger.js";

/** Options accepted by {@link backfillMigrations}. */
export interface BackfillOptions {
  /** Postgres connection string for the database to backfill. */
  databaseUrl: string;
  /** Directory containing the `.sql` migration files whose names should be marked as already applied. Files that don't end in `.sql` are ignored. */
  migrationsDir: string;
  /** Target schema for the pgkit migrations table. Created on demand. Defaults to `"migrator_internal"`. */
  migrationSchema?: string;
  /** Fully-qualified name of the source drizzle migrations table (must include the schema). Defaults to `"drizzle.__drizzle_migrations"`. */
  drizzleMigrationsTable?: string;
}

/**
 * Backfill a database that was previously migrated with `drizzle-kit` so that `@pgkit/migrator` treats the existing migrations as already applied.
 *
 * For each `.sql` file in `migrationsDir`, inserts one row into `migrationSchema.migrations` with `status = 'executed'`, copying the timestamp from the corresponding row in `drizzleMigrationsTable` (matched by position via `to_timestamp(created_at / 1000)`). The insert is `ON CONFLICT DO NOTHING`, so the operation is idempotent — re-running won't duplicate rows. The pgkit migrations schema/table are created on demand if they don't already exist.
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
      const content = await readFile(
        resolve(migrationsDirectory, file),
        "utf8",
      );
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
