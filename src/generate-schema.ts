import assert from "node:assert";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { StringChunk } from "drizzle-orm";
import * as prettier from "prettier";
import { register } from "tsx/esm/api";

import type { PgCustomSQL } from "./sql.js";

const require = createRequire(import.meta.url);
const prettierSqlPlugin = require.resolve("prettier-plugin-sql");

// `register()` installs tsx's TS loader into Node's regular ESM module graph,
// so the user's schema (and anything it imports) is loaded once into the same
// module instances we already have. That means `instanceof` works,
// `pgCustomSQL`'s function body counts toward our coverage, and there's no
// sandbox to leak through. (`tsImport` would re-evaluate everything in a
// fresh graph, breaking both.) Register exactly once so concurrent calls
// don't fight over loader hook installation.
let tsxLoaderRegistered = false;
function ensureTsxLoaderRegistered() {
  if (tsxLoaderRegistered) return;
  register();
  tsxLoaderRegistered = true;
}

/** Options accepted by {@link generateSchemaSql}. */
export interface GenerateSchemaOptions {
  /** Directory containing the Drizzle schema files. Forwarded to `drizzle-kit generate --schema`, and also walked directly so any `pgCustomSQL` snippets exported from those files can be picked up. */
  schemaDir: string;
  /** Filesystem path where the generated `schema.sql` will be written, overwriting any existing file. */
  schemaFile: string;
  /** Command used to invoke drizzle-kit. Defaults to `"npx drizzle-kit"`; override to point at a workspace-local binary or to use a different package manager (e.g. `"pnpm exec drizzle-kit"`). */
  drizzleKitCommand?: string;
  /** Lines emitted as a comment block at the top of the generated file. Defaults to a three-line "auto-generated" notice. */
  header?: string[];
}

const DEFAULT_HEADER = [
  "-- AUTO-GENERATED FILE. DO NOT EDIT.",
  "-- Intermediary DB schema used for generating migrations and checking drift.",
  "-- The Drizzle schema is the source of truth.",
];

function sqlToString(sql: { queryChunks: unknown[] }): string {
  return sql.queryChunks
    .flatMap((chunk) => (chunk instanceof StringChunk ? chunk.value : []))
    .join("")
    .trim();
}

function isPgCustomSQL(value: unknown): value is PgCustomSQL {
  if (typeof value !== "object" || value === null) return false;
  if (!("sql" in value)) return false;
  const inner = (value as { sql: unknown }).sql;
  return (
    typeof inner === "object" &&
    inner !== null &&
    Array.isArray((inner as { queryChunks?: unknown }).queryChunks)
  );
}

/**
 * Generate a single `schema.sql` describing the desired database state from a Drizzle schema.
 *
 * Runs `drizzle-kit generate` into a throwaway directory to get the table/index/constraint DDL, then walks `schemaDir` for any `pgCustomSQL` snippets and weaves them in (negative `priority` before tables, non-negative after). The result is formatted with `prettier-plugin-sql` (Postgres dialect, upper-case keywords) and written to `schemaFile`.
 *
 * Returns the number of snippets placed before (`preCount`) and after (`postCount`) the drizzle-kit output — handy for a one-line summary log.
 */
export async function generateSchemaSql(
  opts: GenerateSchemaOptions,
): Promise<{ preCount: number; postCount: number }> {
  const schemaDir = path.resolve(opts.schemaDir);
  const schemaFile = path.resolve(opts.schemaFile);
  const drizzleKitCommand = opts.drizzleKitCommand ?? "npx drizzle-kit";

  const tempDir = mkdtempSync(path.join(tmpdir(), "drizzle-schema-"));

  let migrationSql: string;
  try {
    try {
      execSync(
        `${drizzleKitCommand} generate --dialect postgresql --schema '${schemaDir}' --out '${tempDir}' --prefix none`,
        { stdio: "pipe" },
      );
    } catch (error: unknown) {
      const stderr =
        error instanceof Error && "stderr" in error
          ? (error as { stderr: Buffer }).stderr?.toString()
          : "";
      const stdout =
        error instanceof Error && "stdout" in error
          ? ((error as { stdout: Buffer }).stdout?.toString() ?? "")
          : "";
      throw new Error(`drizzle-kit generate failed:\n${stderr}\n${stdout}`);
    }

    const sqlFiles = readdirSync(tempDir).filter((f) => f.endsWith(".sql"));
    assert(
      sqlFiles.length === 1,
      `Expected exactly 1 SQL file in ${tempDir}, found ${sqlFiles.length}`,
    );

    migrationSql = readFileSync(path.join(tempDir, sqlFiles[0]!), "utf8");
    migrationSql = migrationSql.replaceAll("--> statement-breakpoint", "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const snippets: { text: string; priority: number }[] = [];

  const schemaFiles = readdirSync(schemaDir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs"))
    .sort();

  ensureTsxLoaderRegistered();
  const seen = new Set<string>();
  for (const file of schemaFiles) {
    const fileUrl = pathToFileURL(path.resolve(schemaDir, file)).href;
    const mod = (await import(fileUrl)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (!isPgCustomSQL(value)) continue;
      const text = sqlToString(value.sql);
      const priority = value.priority ?? 0;
      const key = `${priority}\0${text}`;
      // A schema `index.ts` that re-exports from sibling files would
      // otherwise add every snippet twice (once on direct import, once via
      // the re-export). Dedupe on `(priority, text)`.
      if (seen.has(key)) continue;
      seen.add(key);
      snippets.push({ text, priority });
    }
  }

  snippets.sort((a, b) => a.priority - b.priority);

  const preMigration = snippets
    .filter((s) => s.priority < 0)
    .map((s) => s.text);
  const postMigration = snippets
    .filter((s) => s.priority >= 0)
    .map((s) => s.text);

  const header = (opts.header ?? DEFAULT_HEADER).join("\n");
  const parts: string[] = [header];

  if (preMigration.length > 0) parts.push(preMigration.join("\n\n"));
  parts.push(migrationSql.trim());
  if (postMigration.length > 0) parts.push(postMigration.join("\n\n"));

  const raw = parts.join("\n\n") + "\n";
  const output = await prettier.format(raw, {
    parser: "sql",
    plugins: [prettierSqlPlugin],
    language: "postgresql",
    keywordCase: "upper",
  });

  writeFileSync(schemaFile, output);

  return { preCount: preMigration.length, postCount: postMigration.length };
}
