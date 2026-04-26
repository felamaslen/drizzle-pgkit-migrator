import type { SQL } from "drizzle-orm";

/** Marker type for custom SQL snippets injected into the generated `schema.sql`. */
export type PgCustomSQL = {
  priority?: number;
  sql: SQL;
};

/**
 * Injects a raw SQL snippet into the generated `schema.sql` file.
 *
 * Snippets are sorted by `priority` ascending. The drizzle-kit migration output sits at priority `0`, so:
 *
 * - **Negative priorities** (e.g. `-10`) place the snippet *before* the table defs — use this for extensions, PL/pgSQL functions, or anything that must exist before tables are created.
 * - **Positive priorities** (e.g. `1`) place the snippet *after* the table defs — use this for triggers, deferrable constraints, or other constructs that reference tables.
 */
export function pgCustomSQL(
  sql: SQL,
  options?: { priority?: number },
): PgCustomSQL {
  return { sql, ...options };
}
