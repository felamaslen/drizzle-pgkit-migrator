/**
 * End-to-end demo of the programmatic API.
 *
 * Exercises every exported function:
 *   - generateSchemaSql:  Drizzle schema  ->  __generated__/schema.sql
 *   - createMigration:    schema.sql      ->  migrations/<ts>-<name>.sql
 *   - createMigrator:     migrations/     ->  apply against the database
 *   - backfillMigrations: drizzle journal ->  pgkit migrations table
 *
 * Run:
 *   npm run db:up
 *   npm run programmatic
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  backfillMigrations,
  createMigration,
  createMigrator,
  generateSchemaSql,
} from "drizzle-pgkit-migrator";

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleRoot = path.resolve(here, "..");

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://example:example@localhost:5444/example";

const schemaDir = path.join(exampleRoot, "src/schema");
const schemaFile = path.join(exampleRoot, "__generated__/schema.sql");
const migrationsDir = path.join(exampleRoot, "migrations");

// ---------------------------------------------------------------------------
// 1. Regenerate schema.sql from the Drizzle schema.
// ---------------------------------------------------------------------------
console.log("\n[1/4] generateSchemaSql");
const generated = await generateSchemaSql({ schemaDir, schemaFile });
console.log(
  `  wrote ${schemaFile} (${generated.preCount} pre + ${generated.postCount} post snippets)`,
);

// ---------------------------------------------------------------------------
// 2. Create a migration from any drift between schema.sql and migrations/.
//    On a clean repo this writes a new file. Re-running will report "no
//    changes" because the migration has caught the schema up.
// ---------------------------------------------------------------------------
console.log("\n[2/4] createMigration");
const migrationResult = await createMigration({
  databaseUrl,
  schemaFile,
  migrationsDir,
  name: "programmatic_demo",
  allowEmpty: false,
});
if (migrationResult.migrationFilePath) {
  console.log(`  wrote ${migrationResult.migrationFilePath}`);
} else if (migrationResult.noChanges) {
  console.log("  no drift — schema.sql matches the existing migrations");
}

// ---------------------------------------------------------------------------
// 3. Apply pending migrations.
// ---------------------------------------------------------------------------
console.log("\n[3/4] createMigrator -> up");
const migrator = await createMigrator({
  databaseUrl,
  migrationsDir,
  verbose: true,
});
try {
  await migrator.up();
  console.log("  pending migrations applied");
} finally {
  await migrator.client.end();
}

// ---------------------------------------------------------------------------
// 4. Backfill — only meaningful if a `drizzle.__drizzle_migrations` table
//    exists (i.e. the database was previously managed by drizzle-kit). On a
//    fresh database this is a no-op; we still call it to demonstrate the API.
// ---------------------------------------------------------------------------
console.log("\n[4/4] backfillMigrations");
try {
  await backfillMigrations({ databaseUrl, migrationsDir });
  console.log("  done");
} catch (err) {
  console.log(
    `  skipped: ${err instanceof Error ? err.message : String(err)}\n` +
      "  (backfill expects a `drizzle.__drizzle_migrations` table from a prior drizzle-kit setup)",
  );
}

console.log("\nAll four operations completed.");
