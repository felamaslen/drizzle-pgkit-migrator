import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { run as migra } from "@pgkit/migra";
import pg from "pg";
import * as prettier from "prettier";

import { createMigrator } from "./migrator.js";

const require = createRequire(import.meta.url);
const prettierSqlPlugin = require.resolve("prettier-plugin-sql");

export interface CreateMigrationOptions {
  databaseUrl: string;
  /** Path to the generated schema.sql (the desired state). */
  schemaFile: string;
  /** Directory containing existing migration .sql files. */
  migrationsDir: string;
  /** Migration name. Required unless `exitCode` is true. */
  name?: string;
  /** When true, exit non-zero if there is drift; do not write a file. */
  exitCode?: boolean;
  /** When true and there is no drift, write an empty migration file. */
  allowEmpty?: boolean;
  /** Migration table schema. Defaults to `migrator_internal`. */
  migrationSchema?: string;
  /** Schemas to exclude from the diff. Defaults to `[migrationSchema]`. */
  excludeSchema?: string[];
  /** Run `prettier --write` on the new migration file. Defaults to true. */
  formatWithPrettier?: boolean;
}

export interface CreateMigrationResult {
  /** When `exitCode` is true: drift was detected. */
  drift?: boolean;
  /** Path to the migration file that was written, if any. */
  migrationFilePath?: string;
  /** True if no diff was found. */
  noChanges: boolean;
  /** Diff SQL (when there are changes). */
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

export async function createMigration(
  opts: CreateMigrationOptions,
): Promise<CreateMigrationResult> {
  if (!opts.exitCode && !opts.name) {
    throw new Error("`name` is required unless `exitCode` is set");
  }

  const schemaPath = path.resolve(opts.schemaFile);
  const migrationsDir = path.resolve(opts.migrationsDir);
  const migrationSchema = opts.migrationSchema ?? "migrator_internal";
  const excludeSchema = opts.excludeSchema ?? [migrationSchema];

  const desiredDbName = `migration_desired_${process.pid}`;
  const currentDbName = `migration_current_${process.pid}`;

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
