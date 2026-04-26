import assert from "node:assert";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { run as migra } from "@pgkit/migra";
import pg from "pg";
import * as prettier from "prettier";

import { createMigrator } from "./migrator.js";

const require = createRequire(import.meta.url);
const prettierSqlPlugin = require.resolve("prettier-plugin-sql");

/** Options accepted by {@link createMigration}. */
export interface CreateMigrationOptions {
  /** Postgres connection string used as an admin connection: the function creates two throwaway databases on the same cluster (one to load `schemaFile` into, one to apply existing migrations to) and drops them afterwards. */
  databaseUrl: string;
  /** Filesystem path to the desired-state `schema.sql` — typically the output of {@link generateSchemaSql}. */
  schemaFile: string;
  /** Directory containing existing migration `.sql` files. The new migration is written here on success. */
  migrationsDir: string;
  /** Filename stem for the new migration (the timestamp prefix is added automatically: `YYYYMMDDHHmmss-<name>.sql`). Required unless `exitCode` is `true`. */
  name?: string;
  /** Drift-check mode: report drift via the result instead of writing a file. The function never touches the filesystem in this mode. */
  exitCode?: boolean;
  /** When `true` and there is no diff, still write an empty migration file. Useful when you want a no-op migration to mark a manual change. Ignored when `exitCode` is set. */
  allowEmpty?: boolean;
  /** Schema holding the migrations bookkeeping table (the same schema used by {@link createMigrator}). Excluded from the diff so its presence in the "current" DB doesn't show up as drift. Defaults to `"migrator_internal"`. */
  migrationSchema?: string;
  /** Schemas to exclude from the migra diff. Defaults to `[migrationSchema]`; override to keep additional schemas (e.g. extension-managed ones) out of the generated SQL. */
  excludeSchema?: string[];
  /** Format the new migration file with `prettier-plugin-sql` (Postgres dialect, upper-case keywords). Defaults to `true`. */
  formatWithPrettier?: boolean;
}

/** Result returned by {@link createMigration}. */
export interface CreateMigrationResult {
  /** Only set when called with `exitCode: true`. `true` if the diff was non-empty (i.e. the migrations don't yet match `schemaFile`). */
  drift?: boolean;
  /** Path to the migration file that was written, if any. Unset when `exitCode` is `true`, or when no diff was found and `allowEmpty` was not set. */
  migrationFilePath?: string;
  /** `true` when the diff was empty — schema and applied migrations agree. */
  noChanges: boolean;
  /** Raw diff SQL produced by `@pgkit/migra`. Set whenever there is a non-empty diff (regardless of whether a file was written). */
  sql?: string;
}

async function createDb(adminPool: pg.Pool, name: string) {
  await adminPool
    .query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`)
    .catch(() => {});
  await adminPool.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
}

async function dropDb(adminPool: pg.Pool, name: string) {
  await adminPool
    .query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`)
    .catch(() => {});
}

async function runSqlFile(connectionString: string, filePath: string) {
  const pool = new pg.Pool({ connectionString });
  try {
    const sql = fs.readFileSync(filePath, "utf8");
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

function buildConnectionString(base: string, dbName: string) {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function timestamp() {
  const now = new Date();
  return [
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
}

/**
 * Diff `schemaFile` (desired state) against the result of replaying every migration in `migrationsDir` (current state) and write a new migration containing the difference.
 *
 * Mechanism: two temporary databases are created on the same cluster as `databaseUrl`. The first is loaded from `schemaFile`; the second has the existing migrations applied via {@link createMigrator}. `@pgkit/migra` then diffs the two and the result is written as `migrationsDir/YYYYMMDDHHmmss-<name>.sql` (formatted with `prettier-plugin-sql` unless `formatWithPrettier: false`). Both temp databases are dropped before this function returns, even on error.
 *
 * Use `exitCode: true` for a non-destructive drift check (e.g. in CI) — the function reports the diff via the {@link CreateMigrationResult} without touching the filesystem.
 */
export async function createMigration(
  opts: CreateMigrationOptions,
): Promise<CreateMigrationResult> {
  assert(
    opts.exitCode || opts.name,
    "`name` is required unless `exitCode` is set",
  );

  const schemaPath = path.resolve(opts.schemaFile);
  const migrationsDir = path.resolve(opts.migrationsDir);
  const migrationSchema = opts.migrationSchema ?? "migrator_internal";
  const excludeSchema = opts.excludeSchema ?? [migrationSchema];

  // Use a unique suffix so parallel `createMigration` calls (e.g. several
  // tests in the same suite) don't collide on these temp database names.
  const suffix = randomUUID().replace(/-/g, "");
  const desiredDbName = `migration_desired_${suffix}`;
  const currentDbName = `migration_current_${suffix}`;

  const adminPool = new pg.Pool({ connectionString: opts.databaseUrl });

  try {
    await createDb(adminPool, desiredDbName);
    await createDb(adminPool, currentDbName);

    const desiredUrl = buildConnectionString(opts.databaseUrl, desiredDbName);
    const currentUrl = buildConnectionString(opts.databaseUrl, currentDbName);

    await runSqlFile(desiredUrl, schemaPath);

    const m = await createMigrator({
      databaseUrl: currentUrl,
      migrationsDir,
      migrationSchema,
    });
    await m.up();
    await m.client.end();

    const migration = await migra(currentUrl, desiredUrl, {
      unsafe: true,
      excludeSchema,
    });

    const trimmed = migration.sql.trim();

    if (!trimmed) {
      if (opts.exitCode) {
        return { noChanges: true, drift: false };
      }
      if (opts.allowEmpty) {
        const fileName = `${timestamp()}-${opts.name!}.sql`;
        const filePath = path.join(migrationsDir, fileName);
        fs.writeFileSync(filePath, "");
        return { noChanges: true, migrationFilePath: filePath };
      }
      return { noChanges: true };
    }

    if (opts.exitCode) {
      return { noChanges: false, drift: true, sql: trimmed };
    }

    const fileName = `${timestamp()}-${opts.name!}.sql`;
    const filePath = path.join(migrationsDir, fileName);

    let formatted = `${trimmed}\n`;
    if (opts.formatWithPrettier !== false) {
      formatted = await prettier.format(formatted, {
        parser: "sql",
        plugins: [prettierSqlPlugin],
        language: "postgresql",
        keywordCase: "upper",
      });
    }
    fs.writeFileSync(filePath, formatted);

    return { noChanges: false, migrationFilePath: filePath, sql: trimmed };
  } finally {
    await dropDb(adminPool, desiredDbName);
    await dropDb(adminPool, currentDbName);
    await adminPool.end();
  }
}
