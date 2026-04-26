import type { SQL } from "drizzle-orm";

/** Shape of a custom-SQL snippet recognised by {@link generateSchemaSql}. Produced by {@link pgCustomSQL} — there is normally no reason to construct one directly. */
export type PgCustomSQL = {
  /** Sort key relative to the drizzle-kit migration output (which sits at `0`). Negative values place the snippet before the table defs; non-negative values place it after. */
  priority?: number;
  /** The drizzle `SQL` value to emit verbatim into `schema.sql`. */
  sql: SQL;
};

/**
 * Inject a raw SQL snippet into the generated `schema.sql` file.
 *
 * Export the result from a Drizzle schema file (any module under `--schema-dir`) and {@link generateSchemaSql} will splice it into the output, sorted by `priority` ascending. The drizzle-kit migration output sits at priority `0`, so:
 *
 * - **Negative priorities** (e.g. `-10`) place the snippet *before* the table defs — use this for `CREATE EXTENSION`, PL/pgSQL functions, or anything that must exist before tables are created.
 * - **Positive priorities** (e.g. `1`) place the snippet *after* the table defs — use this for triggers, deferrable constraints, or other constructs that reference tables.
 *
 * @example
 * ```ts
 * export const fuzzystrmatch = pgCustomSQL(
 *   sql`CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;`,
 *   { priority: -10 },
 * );
 * ```
 */
export function pgCustomSQL(
  sql: SQL,
  options?: { priority?: number },
): PgCustomSQL {
  return { sql, ...options };
}
