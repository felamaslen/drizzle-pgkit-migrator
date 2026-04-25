import { sql } from "drizzle-orm";
import { pgCustomSQL } from "drizzle-pgkit-migrator";

/**
 * Demonstrates a *negative-priority* `pgCustomSQL` snippet: this CREATE
 * EXTENSION must run before any table that references functions from it. The
 * generator places anything with `priority < 0` above the drizzle-kit output.
 */
export const citextExtension = pgCustomSQL(
  sql`CREATE EXTENSION IF NOT EXISTS citext;`,
  { priority: -10 },
);
