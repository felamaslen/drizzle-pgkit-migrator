import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigration } from "../src/create-migration.js";
import { generateSchemaSql } from "../src/generate-schema.js";
import { createTempDatabase } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSchemaDir = path.join(here, "fixtures/schema");

let sharedSchemaFile: string;
let sharedSchemaDir: string;

beforeAll(async () => {
  sharedSchemaDir = mkdtempSync(path.join(tmpdir(), "dpkm-test-shared-"));
  sharedSchemaFile = path.join(sharedSchemaDir, "schema.sql");
  await generateSchemaSql({
    schemaDir: fixtureSchemaDir,
    schemaFile: sharedSchemaFile,
  });
});

afterAll(() => {
  rmSync(sharedSchemaDir, { recursive: true, force: true });
});

interface TestContext {
  schemaFile: string;
  migrationsDir: string;
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<TestContext> {
  const workDir = mkdtempSync(path.join(tmpdir(), "dpkm-test-"));
  const migrationsDir = path.join(workDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  const db = await createTempDatabase();
  return {
    schemaFile: sharedSchemaFile,
    migrationsDir,
    databaseUrl: db.url,
    cleanup: async () => {
      await db.drop();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

describe.concurrent("createMigration", () => {
  it("writes a migration containing the diff against an empty database", async () => {
    const ctx = await setup();
    try {
      const result = await createMigration({
        databaseUrl: ctx.databaseUrl,
        schemaFile: ctx.schemaFile,
        migrationsDir: ctx.migrationsDir,
        name: "init",
      });

      expect(result.noChanges).toBe(false);
      expect(result.migrationFilePath).toBeTruthy();
      expect(result.sql).toMatch(/CREATE TABLE\s+(?:"public"\.)?"Widgets"/i);

      const files = readdirSync(ctx.migrationsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{14}-init\.sql$/);

      const written = readFileSync(result.migrationFilePath!, "utf8");
      expect(written).toMatch(/CREATE EXTENSION/i);
      expect(written).toMatch(/CREATE TRIGGER/i);
    } finally {
      await ctx.cleanup();
    }
  });

  it("reports no changes when migrations already match the schema", async () => {
    const ctx = await setup();
    try {
      const first = await createMigration({
        databaseUrl: ctx.databaseUrl,
        schemaFile: ctx.schemaFile,
        migrationsDir: ctx.migrationsDir,
        name: "init",
      });
      expect(first.noChanges).toBe(false);

      const second = await createMigration({
        databaseUrl: ctx.databaseUrl,
        schemaFile: ctx.schemaFile,
        migrationsDir: ctx.migrationsDir,
        name: "should_not_be_written",
      });
      expect(second.noChanges).toBe(true);
      expect(second.migrationFilePath).toBeUndefined();
      expect(readdirSync(ctx.migrationsDir)).toHaveLength(1);
    } finally {
      await ctx.cleanup();
    }
  });

  it("with allowEmpty=true writes an empty file when there are no changes", async () => {
    const ctx = await setup();
    try {
      await createMigration({
        databaseUrl: ctx.databaseUrl,
        schemaFile: ctx.schemaFile,
        migrationsDir: ctx.migrationsDir,
        name: "init",
      });

      const result = await createMigration({
        databaseUrl: ctx.databaseUrl,
        schemaFile: ctx.schemaFile,
        migrationsDir: ctx.migrationsDir,
        name: "empty",
        allowEmpty: true,
      });
      expect(result.noChanges).toBe(true);
      expect(result.migrationFilePath).toBeTruthy();
      expect(readFileSync(result.migrationFilePath!, "utf8")).toBe("");
      expect(readdirSync(ctx.migrationsDir)).toHaveLength(2);
    } finally {
      await ctx.cleanup();
    }
  });

  it("with exitCode=true reports drift without writing a file", async () => {
    const ctx = await setup();
    try {
      const drifted = await createMigration({
        databaseUrl: ctx.databaseUrl,
        schemaFile: ctx.schemaFile,
        migrationsDir: ctx.migrationsDir,
        exitCode: true,
      });
      expect(drifted.drift).toBe(true);
      expect(drifted.sql).toMatch(/CREATE TABLE/i);
      expect(readdirSync(ctx.migrationsDir)).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it("with exitCode=true reports no drift once migrations catch up", async () => {
    const ctx = await setup();
    try {
      await createMigration({
        databaseUrl: ctx.databaseUrl,
        schemaFile: ctx.schemaFile,
        migrationsDir: ctx.migrationsDir,
        name: "init",
      });

      const result = await createMigration({
        databaseUrl: ctx.databaseUrl,
        schemaFile: ctx.schemaFile,
        migrationsDir: ctx.migrationsDir,
        exitCode: true,
      });
      expect(result.drift).toBe(false);
      expect(result.noChanges).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });
});
