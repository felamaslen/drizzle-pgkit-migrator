import path from "node:path";

import { Migrator, noopLogger } from "@pgkit/migrator";
import pg from "pg";

import { logger } from "./logger.js";

export interface MigratorOptions {
  databaseUrl: string;
  migrationsDir: string;
  /** Schema where the migrations table lives. Defaults to `migrator_internal`. */
  migrationSchema?: string;
  /** Migration table name. Defaults to `migrations`. */
  migrationTableName?: string;
  /** When true, log to console; when false, silent. Defaults to false. */
  verbose?: boolean;
}

export async function createMigrator(opts: MigratorOptions): Promise<Migrator> {
  const schema = opts.migrationSchema ?? "migrator_internal";
  const tableName = opts.migrationTableName ?? "migrations";

  const pool = new pg.Pool({ connectionString: opts.databaseUrl });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(schema)}`);
  await pool.end();

  return new Migrator({
    client: opts.databaseUrl,
    migrationsPath: path.resolve(opts.migrationsDir),
    migrationTableName: [schema, tableName],
    logger: opts.verbose ? logger : noopLogger,
  });
}
