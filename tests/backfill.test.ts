import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { main } from "../src/cli.js";

import { createTempDatabase, query } from "./db.js";

const ARGV0 = ["node", "drizzle-pgkit-migrator"];

interface TestContext {
  migrationsDir: string;
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<TestContext> {
  const workDir = mkdtempSync(path.join(tmpdir(), "dpkm-backfill-"));
  const migrationsDir = path.join(workDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  const db = await createTempDatabase();
  return {
    migrationsDir,
    databaseUrl: db.url,
    cleanup: async () => {
      await db.drop();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

function backfillArgs(ctx: TestContext, ...extra: string[]): string[] {
  return [
    ...ARGV0,
    "backfill",
    "--database-url",
    ctx.databaseUrl,
    "--migrations-dir",
    ctx.migrationsDir,
    ...extra,
  ];
}

async function seedDrizzleMigrationsTable(
  databaseUrl: string,
  rows: { hash: string; createdAt: number }[],
) {
  await query(
    databaseUrl,
    `CREATE SCHEMA drizzle;
     CREATE TABLE drizzle.__drizzle_migrations (
       id serial PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );
  for (const row of rows) {
    await query(
      databaseUrl,
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [row.hash, row.createdAt],
    );
  }
}

describe.concurrent("cli: backfill", () => {
  it("copies the drizzle migrations table into the pgkit migrations table", async () => {
    const ctx = await setup();
    try {
      await seedDrizzleMigrationsTable(ctx.databaseUrl, [
        { hash: "hash-1", createdAt: 1700000000000 },
        { hash: "hash-2", createdAt: 1700000060000 },
      ]);

      writeFileSync(
        path.join(ctx.migrationsDir, "0001_first.sql"),
        "-- first migration content",
      );
      writeFileSync(
        path.join(ctx.migrationsDir, "0002_second.sql"),
        "-- second migration content",
      );
      writeFileSync(path.join(ctx.migrationsDir, "README.md"), "skip me");

      const code = await main(backfillArgs(ctx));
      expect(code).toBe(0);

      const rows = await query<{
        name: string;
        content: string;
        status: string;
      }>(
        ctx.databaseUrl,
        `SELECT name, content, status FROM migrator_internal.migrations ORDER BY name`,
      );
      expect(rows.rows.map((r) => r.name)).toEqual([
        "0001_first.sql",
        "0002_second.sql",
      ]);
      expect(rows.rows[0]!.content).toBe("-- first migration content");
      expect(rows.rows[1]!.content).toBe("-- second migration content");
      expect(rows.rows.every((r) => r.status === "executed")).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("is idempotent — re-running does not duplicate rows", async () => {
    const ctx = await setup();
    try {
      await seedDrizzleMigrationsTable(ctx.databaseUrl, [
        { hash: "h", createdAt: 1700000000000 },
      ]);
      writeFileSync(path.join(ctx.migrationsDir, "0001_a.sql"), "a");

      expect(await main(backfillArgs(ctx))).toBe(0);
      expect(await main(backfillArgs(ctx))).toBe(0);

      const rows = await query<{ count: string }>(
        ctx.databaseUrl,
        `SELECT count(*)::text AS count FROM migrator_internal.migrations`,
      );
      expect(rows.rows[0]!.count).toBe("1");
    } finally {
      await ctx.cleanup();
    }
  });

  it("supports a custom --migration-schema", async () => {
    const ctx = await setup();
    try {
      await seedDrizzleMigrationsTable(ctx.databaseUrl, [
        { hash: "h", createdAt: 1700000000000 },
      ]);
      writeFileSync(path.join(ctx.migrationsDir, "0001_a.sql"), "a");

      const code = await main(
        backfillArgs(ctx, "--migration-schema", "elsewhere"),
      );
      expect(code).toBe(0);

      const rows = await query<{ name: string }>(
        ctx.databaseUrl,
        `SELECT name FROM elsewhere.migrations`,
      );
      expect(rows.rows.map((r) => r.name)).toEqual(["0001_a.sql"]);
    } finally {
      await ctx.cleanup();
    }
  });
});
