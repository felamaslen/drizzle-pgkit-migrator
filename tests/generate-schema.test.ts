import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSchemaDir = path.join(here, "fixtures/schema");
const ARGV0 = ["node", "drizzle-pgkit-migrator"];

interface TestContext {
  outDir: string;
  schemaFile: string;
  cleanup: () => void;
}

function setup(): TestContext {
  const outDir = mkdtempSync(path.join(tmpdir(), "dpkm-test-"));
  const schemaFile = path.join(outDir, "schema.sql");
  return {
    outDir,
    schemaFile,
    cleanup: () => rmSync(outDir, { recursive: true, force: true }),
  };
}

describe.concurrent("cli: generate-schema", () => {
  it("writes a schema.sql containing tables and pgCustomSQL snippets in priority order", async ({
    expect,
  }) => {
    const ctx = setup();
    try {
      const code = await main([
        ...ARGV0,
        "generate-schema",
        "--schema-dir",
        fixtureSchemaDir,
        "--schema-file",
        ctx.schemaFile,
      ]);

      expect(code).toBe(0);

      const sql = readFileSync(ctx.schemaFile, "utf8");

      // Pre-migration must come before the table; post-migration after.
      const extIdx = sql.search(/CREATE EXTENSION IF NOT EXISTS citext/i);
      const tableIdx = sql.search(/CREATE TABLE "Widgets"/);
      const triggerIdx = sql.search(
        /CREATE TRIGGER "Widgets_setUpdatedAt_trg"/,
      );
      expect(extIdx).toBeGreaterThanOrEqual(0);
      expect(tableIdx).toBeGreaterThan(extIdx);
      expect(triggerIdx).toBeGreaterThan(tableIdx);

      expect(sql).toMatchInlineSnapshot(`
        "-- AUTO-GENERATED FILE. DO NOT EDIT.
        -- Intermediary DB schema used for generating migrations and checking drift.
        -- The Drizzle schema is the source of truth.
        CREATE EXTENSION IF NOT EXISTS citext;

        CREATE TABLE "Widgets" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "name" text NOT NULL,
          "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
          "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
        );

        CREATE OR REPLACE FUNCTION "Widgets_setUpdatedAt" () RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              NEW."updatedAt" := now();
              RETURN NEW;
            END;
            $$;

        CREATE TRIGGER "Widgets_setUpdatedAt_trg" BEFORE
        UPDATE ON "Widgets" FOR EACH ROW
        EXECUTE FUNCTION "Widgets_setUpdatedAt" ();
        "
      `);
    } finally {
      ctx.cleanup();
    }
  });

  it("exits non-zero when --schema-dir is missing", async () => {
    const ctx = setup();
    try {
      const code = await main([
        ...ARGV0,
        "generate-schema",
        "--schema-file",
        ctx.schemaFile,
      ]);
      expect(code).not.toBe(0);
    } finally {
      ctx.cleanup();
    }
  });
});
