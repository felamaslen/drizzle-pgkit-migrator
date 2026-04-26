import path from "node:path";

import { Migrator, noopLogger } from "@pgkit/migrator";
import pg from "pg";

import { logger } from "./logger.js";

/** Options accepted by {@link createMigrator}. */
export interface MigratorOptions {
  /** Postgres connection string for the database to migrate. */
  databaseUrl: string;
  /** Filesystem path to the directory containing the `.sql` migration files. Resolved against `process.cwd()`. */
  migrationsDir: string;
  /** Schema that holds the migrations bookkeeping table. Created on demand if it doesn't already exist. Defaults to `"migrator_internal"`. */
  migrationSchema?: string;
  /** Name of the migrations bookkeeping table inside `migrationSchema`. Defaults to `"migrations"`. */
  migrationTableName?: string;
  /** When `true`, the underlying `@pgkit/migrator` logs to the console; when `false` it is silent. Defaults to `false`. */
  verbose?: boolean;
}

/**
 * Create a configured `@pgkit/migrator` instance pointed at the given database and migrations directory.
 *
 * The returned `Migrator` exposes the full pgkit API (`up`, `executed`, `pending`, `latest`, `goto`, etc.). The migrations schema is created if it doesn't already exist, so the first call against a fresh database is safe.
 *
 * Remember to call `migrator.client.end()` when done so the underlying connection pool drains.
 */
export async function createMigrator(opts: MigratorOptions): Promise<Migrator> {
  const schema = opts.migrationSchema ?? "migrator_internal";
  const tableName = opts.migrationTableName ?? "migrations";

  const pool = new pg.Pool({ connectionString: opts.databaseUrl });
  await pool.query(
    `CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(schema)}`,
  );
  await pool.end();

  return new Migrator({
    client: opts.databaseUrl,
    migrationsPath: path.resolve(opts.migrationsDir),
    migrationTableName: [schema, tableName],
    logger: opts.verbose ? logger : noopLogger,
  });
}
