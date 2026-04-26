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
      expect(result.sql).toMatchInlineSnapshot(`
        "create extension if not exists "citext" with schema "public" version '1.8';


          create table "public"."Widgets" (
            "id" uuid not null default gen_random_uuid(),
            "name" text not null,
            "createdAt" timestamp with time zone not null default now(),
            "updatedAt" timestamp with time zone not null default now()
              );


        CREATE UNIQUE INDEX "Widgets_pkey" ON public."Widgets" USING btree (id);

        alter table "public"."Widgets" add constraint "Widgets_pkey" PRIMARY KEY using index "Widgets_pkey";

        set check_function_bodies = off;

        CREATE OR REPLACE FUNCTION public."Widgets_setUpdatedAt"()
         RETURNS trigger
         LANGUAGE plpgsql
        AS $function$
            BEGIN
              NEW."updatedAt" := now();
              RETURN NEW;
            END;
            $function$
        ;

        CREATE TRIGGER "Widgets_setUpdatedAt_trg" BEFORE UPDATE ON public."Widgets" FOR EACH ROW EXECUTE FUNCTION "Widgets_setUpdatedAt"();"
      `);

      const files = readdirSync(ctx.migrationsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchInlineSnapshot(`"20260115123456-init.sql"`);

      const written = readFileSync(result.migrationFilePath!, "utf8");
      expect(written).toMatchInlineSnapshot(`
        "CREATE EXTENSION if NOT EXISTS "citext"
        WITH
          schema "public" version '1.8';

        CREATE TABLE "public"."Widgets" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "name" text NOT NULL,
          "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
          "updatedAt" timestamp with time zone NOT NULL DEFAULT now()
        );

        CREATE UNIQUE INDEX "Widgets_pkey" ON public."Widgets" USING btree (id);

        ALTER TABLE "public"."Widgets"
        ADD CONSTRAINT "Widgets_pkey" PRIMARY KEY USING index "Widgets_pkey";

        SET
          check_function_bodies = off;

        CREATE OR REPLACE FUNCTION public."Widgets_setUpdatedAt" () RETURNS trigger LANGUAGE plpgsql AS $function$
            BEGIN
              NEW."updatedAt" := now();
              RETURN NEW;
            END;
            $function$;

        CREATE TRIGGER "Widgets_setUpdatedAt_trg" BEFORE
        UPDATE ON public."Widgets" FOR EACH ROW
        EXECUTE FUNCTION "Widgets_setUpdatedAt" ();
        "
      `);
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
      expect(drifted.sql).toMatchInlineSnapshot(`
        "create extension if not exists "citext" with schema "public" version '1.8';


          create table "public"."Widgets" (
            "id" uuid not null default gen_random_uuid(),
            "name" text not null,
            "createdAt" timestamp with time zone not null default now(),
            "updatedAt" timestamp with time zone not null default now()
              );


        CREATE UNIQUE INDEX "Widgets_pkey" ON public."Widgets" USING btree (id);

        alter table "public"."Widgets" add constraint "Widgets_pkey" PRIMARY KEY using index "Widgets_pkey";

        set check_function_bodies = off;

        CREATE OR REPLACE FUNCTION public."Widgets_setUpdatedAt"()
         RETURNS trigger
         LANGUAGE plpgsql
        AS $function$
            BEGIN
              NEW."updatedAt" := now();
              RETURN NEW;
            END;
            $function$
        ;

        CREATE TRIGGER "Widgets_setUpdatedAt_trg" BEFORE UPDATE ON public."Widgets" FOR EACH ROW EXECUTE FUNCTION "Widgets_setUpdatedAt"();"
      `);
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
