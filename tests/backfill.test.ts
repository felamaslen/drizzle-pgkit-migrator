import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backfillMigrations } from "../src/backfill.js";

import { createTempDatabase, query } from "./db.js";

describe("backfillMigrations", () => {
  let workDir: string;
  let migrationsDir: string;
  let db: { url: string; drop: () => Promise<void> };

  beforeEach(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "dpkm-backfill-"));
    migrationsDir = path.join(workDir, "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    db = await createTempDatabase();
  });

  afterEach(async () => {
    await db.drop();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("copies the drizzle migrations table into the pgkit migrations table", async () => {
    // Set up a simulated drizzle-managed database with two applied migrations.
    await query(
      db.url,
      `CREATE SCHEMA drizzle;
       CREATE TABLE drizzle.__drizzle_migrations (
         id serial PRIMARY KEY,
         hash text NOT NULL,
         created_at bigint
       );
       INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES
         ('hash-1', 1700000000000),
         ('hash-2', 1700000060000);`,
    );

    writeFileSync(
      path.join(migrationsDir, "0001_first.sql"),
      `-- first migration content`,
    );
    writeFileSync(
      path.join(migrationsDir, "0002_second.sql"),
      `-- second migration content`,
    );
    // Non-SQL file should be ignored.
    writeFileSync(path.join(migrationsDir, "README.md"), "skip me");

    await backfillMigrations({ databaseUrl: db.url, migrationsDir });

    const rows = await query<{
      name: string;
      content: string;
      status: string;
    }>(
      db.url,
      `SELECT name, content, status FROM migrator_internal.migrations ORDER BY name`,
    );
    expect(rows.rows.map((r) => r.name)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);
    expect(rows.rows[0]!.content).toBe("-- first migration content");
    expect(rows.rows[1]!.content).toBe("-- second migration content");
    expect(rows.rows.every((r) => r.status === "executed")).toBe(true);
  });

  it("is idempotent — re-running does not duplicate rows", async () => {
    await query(
      db.url,
      `CREATE SCHEMA drizzle;
       CREATE TABLE drizzle.__drizzle_migrations (
         id serial PRIMARY KEY, hash text, created_at bigint
       );
       INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('h', 1700000000000);`,
    );

    writeFileSync(path.join(migrationsDir, "0001_a.sql"), "a");

    await backfillMigrations({ databaseUrl: db.url, migrationsDir });
    await backfillMigrations({ databaseUrl: db.url, migrationsDir });

    const rows = await query<{ count: string }>(
      db.url,
      `SELECT count(*)::text AS count FROM migrator_internal.migrations`,
    );
    expect(rows.rows[0]!.count).toBe("1");
  });

  it("supports a custom migration schema name", async () => {
    await query(
      db.url,
      `CREATE SCHEMA drizzle;
       CREATE TABLE drizzle.__drizzle_migrations (
         id serial PRIMARY KEY, hash text, created_at bigint
       );
       INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('h', 1700000000000);`,
    );
    writeFileSync(path.join(migrationsDir, "0001_a.sql"), "a");

    await backfillMigrations({
      databaseUrl: db.url,
      migrationsDir,
      migrationSchema: "elsewhere",
    });

    const rows = await query<{ name: string }>(
      db.url,
      `SELECT name FROM elsewhere.migrations`,
    );
    expect(rows.rows.map((r) => r.name)).toEqual(["0001_a.sql"]);
  });
});
