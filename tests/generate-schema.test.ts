import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateSchemaSql } from "../src/generate-schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(here, "fixtures/schema");

describe("generateSchemaSql", () => {
  let outDir: string;
  let schemaFile: string;

  beforeEach(() => {
    outDir = mkdtempSync(path.join(tmpdir(), "dpkm-test-"));
    schemaFile = path.join(outDir, "schema.sql");
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes a schema.sql containing tables and pgCustomSQL snippets in priority order", async () => {
    const result = await generateSchemaSql({ schemaDir, schemaFile });

    expect(result.preCount).toBe(1);
    expect(result.postCount).toBe(1);

    const sql = readFileSync(schemaFile, "utf8");

    // Pre-migration snippet (negative priority) appears.
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS citext/i);
    // Drizzle table appears.
    expect(sql).toMatch(/CREATE TABLE "Widgets"/);
    // Post-migration snippet (positive priority) appears.
    expect(sql).toMatch(/CREATE TRIGGER "Widgets_setUpdatedAt_trg"/);

    // Pre-migration must come before the table; post-migration after.
    const extIdx = sql.search(/CREATE EXTENSION IF NOT EXISTS citext/i);
    const tableIdx = sql.search(/CREATE TABLE "Widgets"/);
    const triggerIdx = sql.search(/CREATE TRIGGER "Widgets_setUpdatedAt_trg"/);
    expect(extIdx).toBeGreaterThanOrEqual(0);
    expect(tableIdx).toBeGreaterThan(extIdx);
    expect(triggerIdx).toBeGreaterThan(tableIdx);
  });

  it("formats output via prettier-plugin-sql with upper-case keywords", async () => {
    await generateSchemaSql({ schemaDir, schemaFile });
    const sql = readFileSync(schemaFile, "utf8");
    // prettier-plugin-sql with keywordCase: "upper" produces e.g.
    //   CREATE TABLE "Widgets" (
    //     "id" uuid PRIMARY KEY DEFAULT ...
    expect(sql).toMatch(/PRIMARY KEY/);
    expect(sql).toMatch(/NOT NULL/);
  });
});
