import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMigrator } from "../src/migrator.js";

import { createTempDatabase, query } from "./db.js";

describe("createMigrator", () => {
  let workDir: string;
  let migrationsDir: string;
  let db: { url: string; drop: () => Promise<void> };

  beforeEach(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "dpkm-migrator-"));
    migrationsDir = path.join(workDir, "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    db = await createTempDatabase();
  });

  afterEach(async () => {
    await db.drop();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("creates the migrator schema and applies pending migrations", async () => {
    writeFileSync(
      path.join(migrationsDir, "20260101000000-create_thing.sql"),
      `CREATE TABLE "Thing" ("id" int PRIMARY KEY);`,
    );
    writeFileSync(
      path.join(migrationsDir, "20260101000001-add_column.sql"),
      `ALTER TABLE "Thing" ADD COLUMN "name" text NOT NULL DEFAULT '';`,
    );

    const m = await createMigrator({
      databaseUrl: db.url,
      migrationsDir,
    });
    try {
      await m.up();
    } finally {
      await m.client.end();
    }

    // Both migrations applied: table exists with both columns.
    const cols = await query<{ column_name: string }>(
      db.url,
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Thing' ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["id", "name"]);

    // Migrator's bookkeeping rows exist.
    const tracked = await query<{ name: string; status: string }>(
      db.url,
      `SELECT name, status FROM migrator_internal.migrations ORDER BY name`,
    );
    expect(tracked.rows.map((r) => r.name)).toEqual([
      "20260101000000-create_thing.sql",
      "20260101000001-add_column.sql",
    ]);
    expect(tracked.rows.every((r) => r.status === "executed")).toBe(true);
  });

  it("re-running up after success is a no-op", async () => {
    writeFileSync(
      path.join(migrationsDir, "20260101000000-noop.sql"),
      `CREATE TABLE "X" (id int);`,
    );

    const first = await createMigrator({ databaseUrl: db.url, migrationsDir });
    try {
      await first.up();
    } finally {
      await first.client.end();
    }

    const second = await createMigrator({ databaseUrl: db.url, migrationsDir });
    try {
      // Should resolve without throwing — pgkit reports no pending migrations.
      await second.up();
    } finally {
      await second.client.end();
    }

    const tables = await query<{ table_name: string }>(
      db.url,
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'X'`,
    );
    expect(tables.rows).toHaveLength(1);
  });

  it("supports a custom migration schema name", async () => {
    writeFileSync(
      path.join(migrationsDir, "20260101000000-custom.sql"),
      `CREATE TABLE "C" (id int);`,
    );

    const m = await createMigrator({
      databaseUrl: db.url,
      migrationsDir,
      migrationSchema: "my_custom_migrator",
    });
    try {
      await m.up();
    } finally {
      await m.client.end();
    }

    const tracked = await query<{ name: string }>(
      db.url,
      `SELECT name FROM my_custom_migrator.migrations`,
    );
    expect(tracked.rows.map((r) => r.name)).toEqual([
      "20260101000000-custom.sql",
    ]);

    // Default schema should not exist.
    const def = await query<{ exists: boolean }>(
      db.url,
      `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'migrator_internal') AS exists`,
    );
    expect(def.rows[0]!.exists).toBe(false);
  });
});
