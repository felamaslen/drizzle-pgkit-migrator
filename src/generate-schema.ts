import { execSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { StringChunk } from "drizzle-orm";
import * as prettier from "prettier";

import { PgCustomSQL } from "./sql.js";

export interface GenerateSchemaOptions {
  /** Drizzle schema directory (passed to `drizzle-kit generate --schema`). */
  schemaDir: string;
  /** Output schema.sql file path. */
  schemaFile: string;
  /** Path to drizzle-kit binary. Defaults to `npx drizzle-kit`. */
  drizzleKitCommand?: string;
  /** Header comment to write at the top of the file. */
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
    if (sqlFiles.length !== 1) {
      throw new Error(
        `Expected exactly 1 SQL file in ${tempDir}, found ${sqlFiles.length}`,
      );
    }

    migrationSql = readFileSync(path.join(tempDir, sqlFiles[0]!), "utf8");
    migrationSql = migrationSql.replaceAll("--> statement-breakpoint", "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const snippets: { text: string; priority: number }[] = [];

  const schemaFiles = readdirSync(schemaDir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs"))
    .sort();

  for (const file of schemaFiles) {
    const fileUrl = pathToFileURL(path.resolve(schemaDir, file)).href;
    const mod = (await import(fileUrl)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (value instanceof PgCustomSQL) {
        snippets.push({
          text: sqlToString(value.sql),
          priority: value.options?.priority ?? 0,
        });
      }
    }
  }

  snippets.sort((a, b) => a.priority - b.priority);

  const preMigration = snippets.filter((s) => s.priority < 0).map((s) => s.text);
  const postMigration = snippets
    .filter((s) => s.priority >= 0)
    .map((s) => s.text);

  const header = (opts.header ?? DEFAULT_HEADER).join("\n");
  const parts: string[] = [header];

  if (preMigration.length > 0) parts.push(preMigration.join("\n\n"));
  parts.push(migrationSql.trim());
  if (postMigration.length > 0) parts.push(postMigration.join("\n\n"));

  const prettierConfig = await prettier.resolveConfig(schemaFile);
  const raw = parts.join("\n\n") + "\n";
  const output = await prettier.format(raw, {
    ...prettierConfig,
    filepath: schemaFile,
  });

  writeFileSync(schemaFile, output);

  return { preCount: preMigration.length, postCount: postMigration.length };
}
