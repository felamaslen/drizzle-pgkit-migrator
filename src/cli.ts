#!/usr/bin/env node

import assert from "node:assert";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { backfillMigrations } from "./backfill.js";
import { createMigration } from "./create-migration.js";
import { generateSchemaSql } from "./generate-schema.js";
import { createMigrator } from "./migrator.js";

/**
 * Dispatch to a method on the pgkit migrator instance. We bypass pgkit's
 * own `Migrator.cli().run()` because it ultimately calls `process.exit()`,
 * which is incompatible with running the CLI in-process from tests.
 */
async function runPgkitSubcommand(
  migrator: Awaited<ReturnType<typeof createMigrator>>,
  args: string[],
): Promise<void> {
  const [command] = args;
  assert(
    command,
    "migrate requires a subcommand: up, list, ls, executed, pending.",
  );

  switch (command) {
    case "up":
      await migrator.up();
      return;
    case "list":
    case "ls":
      console.log(JSON.stringify(await migrator.list(), null, 2));
      return;
    case "executed":
      console.log(JSON.stringify(await migrator.executed(), null, 2));
      return;
    case "pending":
      console.log(JSON.stringify(await migrator.pending(), null, 2));
      return;
    default:
      throw new Error(
        `Unknown migrate subcommand: ${command}. Supported: up, list, executed, pending.`,
      );
  }
}

function defaultDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  assert(url, "Missing database URL. Pass --database-url or set DATABASE_URL.");
  return url;
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name("drizzle-pgkit-migrator")
    .description(
      "Glue between drizzle-kit and @pgkit/migrator: generate schema.sql from a Drizzle schema, diff to create migrations, and run them with pgkit.",
    )
    .version("0.1.0")
    .enablePositionalOptions()
    // Throw instead of calling `process.exit` so callers (incl. tests) can
    // observe the exit code without the process actually exiting.
    .exitOverride();

  // -------------------------------------------------------------------------
  // migrate — delegate to pgkit migrator's built-in CLI
  // -------------------------------------------------------------------------
  program
    .command("migrate")
    .description(
      "Run @pgkit/migrator. Subcommands (up, down, list, etc.) are forwarded to the pgkit migrator CLI.",
    )
    .option(
      "--database-url <url>",
      "Postgres connection string (or DATABASE_URL)",
    )
    .option(
      "--migrations-dir <path>",
      "Directory containing .sql migration files",
      "migrations",
    )
    .option(
      "--migration-schema <name>",
      "Schema for the migrations table",
      "migrator_internal",
    )
    .option("--migration-table <name>", "Migrations table name", "migrations")
    .argument(
      "[pgkitArgs...]",
      "Subcommand and flags forwarded to @pgkit/migrator (e.g. `up`, `down --to <name>`, `list`)",
    )
    .passThroughOptions()
    .action(async (pgkitArgs: string[], opts: Record<string, string>) => {
      const m = await createMigrator({
        databaseUrl: opts.databaseUrl ?? defaultDatabaseUrl(),
        migrationsDir: opts.migrationsDir!,
        migrationSchema: opts.migrationSchema,
        migrationTableName: opts.migrationTable,
        verbose: true,
      });

      try {
        await runPgkitSubcommand(m, pgkitArgs);
      } finally {
        await m.client.end();
      }
    });

  // -------------------------------------------------------------------------
  // generate-schema — drizzle schema → schema.sql
  // -------------------------------------------------------------------------
  program
    .command("generate-schema")
    .description(
      "Generate schema.sql from the Drizzle schema (combines drizzle-kit output with `pgCustomSQL` snippets).",
    )
    .requiredOption(
      "--schema-dir <path>",
      "Directory containing the Drizzle schema files",
    )
    .requiredOption("--schema-file <path>", "Output schema.sql file path")
    .option(
      "--drizzle-kit-command <cmd>",
      "Command used to invoke drizzle-kit",
      "npx drizzle-kit",
    )
    .action(async (opts: Record<string, string>) => {
      const result = await generateSchemaSql({
        schemaDir: opts.schemaDir!,
        schemaFile: opts.schemaFile!,
        drizzleKitCommand: opts.drizzleKitCommand,
      });
      console.log(
        `Generated ${opts.schemaFile} (${result.preCount} pre-migration, ${result.postCount} post-migration SQL snippets)`,
      );
    });

  // -------------------------------------------------------------------------
  // create — diff schema.sql vs applied migrations → new migration .sql
  // -------------------------------------------------------------------------
  program
    .command("create")
    .description(
      "Diff schema.sql against the result of applying existing migrations and write a new migration file with the difference.",
    )
    .option(
      "--database-url <url>",
      "Postgres connection string (or DATABASE_URL)",
    )
    .requiredOption(
      "--schema-file <path>",
      "Path to the desired-state schema.sql",
    )
    .requiredOption(
      "--migrations-dir <path>",
      "Directory where migration .sql files live",
    )
    .option(
      "--migration-schema <name>",
      "Schema for the migrations table",
      "migrator_internal",
    )
    .option("--name <name>", "Migration name (required unless --exit-code)")
    .option("--allow-empty", "Write an empty file when there are no changes")
    .option(
      "--exit-code",
      "Exit non-zero if there is drift; do not write a file (CI drift check)",
    )
    .option(
      "--no-format",
      "Skip running `npx prettier --write` on the new file",
    )
    .action(async (opts: Record<string, string | boolean>) => {
      const result = await createMigration({
        databaseUrl: (opts.databaseUrl as string) ?? defaultDatabaseUrl(),
        schemaFile: opts.schemaFile as string,
        migrationsDir: opts.migrationsDir as string,
        migrationSchema: opts.migrationSchema as string,
        name: opts.name as string | undefined,
        allowEmpty: Boolean(opts.allowEmpty),
        exitCode: Boolean(opts.exitCode),
        formatWithPrettier: opts.format !== false,
      });

      if (opts.exitCode) {
        if (result.drift) {
          throw new Error(`Schema drift detected. Differences:\n${result.sql}`);
        }
        console.log("No differences found. Schema is up to date.");
        return;
      }

      if (result.noChanges) {
        if (result.migrationFilePath) {
          console.log(
            `No differences found. Created empty migration: ${result.migrationFilePath}`,
          );
          return;
        }
        throw new Error(
          "No differences found. Schema is up to date. Use --allow-empty to create an empty migration.",
        );
      }

      console.log(`Created migration: ${result.migrationFilePath}`);
    });

  // -------------------------------------------------------------------------
  // backfill — drizzle migrations table → pgkit migrations table
  // -------------------------------------------------------------------------
  program
    .command("backfill")
    .description(
      "Backfill a database previously migrated with drizzle-kit so @pgkit/migrator sees the existing migrations as applied.",
    )
    .option(
      "--database-url <url>",
      "Postgres connection string (or DATABASE_URL)",
    )
    .requiredOption(
      "--migrations-dir <path>",
      "Directory containing migration .sql files",
    )
    .option(
      "--migration-schema <name>",
      "Target schema for the pgkit migrations table",
      "migrator_internal",
    )
    .option(
      "--drizzle-migrations-table <name>",
      "Source drizzle migrations table",
      "drizzle.__drizzle_migrations",
    )
    .action(async (opts: Record<string, string>) => {
      await backfillMigrations({
        databaseUrl: opts.databaseUrl ?? defaultDatabaseUrl(),
        migrationsDir: opts.migrationsDir!,
        migrationSchema: opts.migrationSchema,
        drizzleMigrationsTable: opts.drizzleMigrationsTable,
      });
      console.log("Backfill complete.");
    });

  return program;
}

/**
 * Parse and run the CLI for the given `argv`. Returns the exit code: zero on
 * success, non-zero on any handled error. Unrelated thrown errors propagate
 * (those are bugs).
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // `--help` / `--version` reach here via `exitOverride`; commander has
      // already written the output and signals the intended exit code (0 for
      // help/version, 1 for usage errors).
      return err.exitCode;
    }
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  process.exit(await main());
}
