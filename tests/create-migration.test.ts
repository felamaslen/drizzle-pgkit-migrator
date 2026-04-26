import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { generateSchemaSql } from "../src/generate-schema.js";

import { createTempDatabase } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSchemaDir = path.join(here, "fixtures/schema");
const ARGV0 = ["node", "drizzle-pgkit-migrator"];

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

function createArgs(ctx: TestContext, ...extra: string[]): string[] {
  return [
    ...ARGV0,
    "create",
    "--database-url",
    ctx.databaseUrl,
    "--schema-file",
    ctx.schemaFile,
    "--migrations-dir",
    ctx.migrationsDir,
    ...extra,
  ];
}

describe.concurrent("cli: create", () => {
  it("writes a migration containing the diff against an empty database", async ({
    expect,
  }) => {
    const ctx = await setup();
    try {
      const code = await main(createArgs(ctx, "--name", "init"));
      expect(code).toBe(0);

      const files = readdirSync(ctx.migrationsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchInlineSnapshot(`"20260115123456-init.sql"`);

      const written = readFileSync(
        path.join(ctx.migrationsDir, files[0]!),
        "utf8",
      );
      expect(written).toMatch(/CREATE EXTENSION/i);
      expect(written).toMatch(/CREATE TABLE\s+"public"\."Widgets"/i);
      expect(written).toMatch(/CREATE TRIGGER/i);
    } finally {
      await ctx.cleanup();
    }
  });

  it("exits 1 when there are no changes and --allow-empty is not set", async () => {
    const ctx = await setup();
    try {
      const first = await main(createArgs(ctx, "--name", "init"));
      expect(first).toBe(0);

      const second = await main(
        createArgs(ctx, "--name", "should_not_be_written"),
      );
      expect(second).toBe(1);
      expect(readdirSync(ctx.migrationsDir)).toHaveLength(1);
    } finally {
      await ctx.cleanup();
    }
  });

  it("with --allow-empty writes an empty file when there are no changes", async () => {
    const ctx = await setup();
    try {
      await main(createArgs(ctx, "--name", "init"));

      const code = await main(
        createArgs(ctx, "--name", "empty", "--allow-empty"),
      );
      expect(code).toBe(0);

      const files = readdirSync(ctx.migrationsDir).sort();
      expect(files).toHaveLength(2);
      const empty = files.find((f) => f.endsWith("-empty.sql"))!;
      expect(readFileSync(path.join(ctx.migrationsDir, empty), "utf8")).toBe(
        "",
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("with --exit-code reports drift via non-zero exit and writes nothing", async () => {
    const ctx = await setup();
    try {
      const code = await main(createArgs(ctx, "--exit-code"));
      expect(code).toBe(1);
      expect(readdirSync(ctx.migrationsDir)).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it("with --exit-code returns 0 once migrations catch the schema up", async () => {
    const ctx = await setup();
    try {
      await main(createArgs(ctx, "--name", "init"));

      const code = await main(createArgs(ctx, "--exit-code"));
      expect(code).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  });
});
