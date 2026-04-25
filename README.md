# drizzle-pgkit-migrator

CLI glue between [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) and [`@pgkit/migrator`](https://www.npmjs.com/package/@pgkit/migrator) / [`@pgkit/migra`](https://www.npmjs.com/package/@pgkit/migra).

## Motivation

Drizzle is a great way to author a Postgres schema in TypeScript, but `drizzle-kit`'s migration workflow leans on a journal (`_journal.json` plus per-migration snapshot files) to know what changed. The journal is fragile: it's easy to corrupt during rebases, hard to reason about across long-lived branches, and ties every migration to drizzle-kit's internal snapshot format rather than to the actual database state.

This package lets the **Drizzle schema be the single source of truth** for what the database should look like, with **no migration journal**. The flow:

1. Author tables in Drizzle as usual.
2. `generate-schema` produces a plain `schema.sql` describing the desired state directly from the Drizzle schema (plus any raw-SQL snippets for things Drizzle can't express — extensions, triggers, custom functions).
3. `create` diffs `schema.sql` against the result of replaying your existing `.sql` migrations into a throwaway database, using `@pgkit/migra`. The output is a normal SQL migration file — no snapshot, no journal.
4. `migrate` runs those plain SQL files against your real database with `@pgkit/migrator`, which tracks applied migrations in a regular table.

The result: migrations are just SQL files, the schema is just Drizzle, and the only state that matters is what's actually in the database.

It lets you keep authoring your schema in Drizzle while running migrations with pgkit:

1. **`generate-schema`** — turns your Drizzle schema (plus optional raw-SQL snippets) into a single `schema.sql` describing the desired state.
2. **`create`** — spins up two throwaway databases (one from `schema.sql`, one from your existing migrations) and uses `@pgkit/migra` to write a new migration containing the diff.
3. **`migrate up|down|list|...`** — runs `@pgkit/migrator` against your real database. Subcommands and flags are forwarded to pgkit's own CLI.
4. **`backfill`** — for repos switching off `drizzle-kit` migrations: copies the existing `drizzle.__drizzle_migrations` history into the pgkit migrations table so they're treated as already applied.

## Install

```sh
npm install --save-dev drizzle-pgkit-migrator drizzle-kit
```

## CLI

```sh
npx drizzle-pgkit-migrator <command> [options]
```

All commands accept `--database-url` (or read `DATABASE_URL` from the environment).

### `generate-schema`

```sh
npx drizzle-pgkit-migrator generate-schema \
  --schema-dir src/db/schema \
  --schema-file src/db/__generated__/schema.sql
```

Runs `drizzle-kit generate` into a temp dir, then weaves in any `pgCustomSQL` snippets exported from your schema files (sorted by `priority` — negative goes before tables, positive goes after).

### `create`

```sh
npx drizzle-pgkit-migrator create \
  --schema-file src/db/__generated__/schema.sql \
  --migrations-dir src/db/migrations \
  --name add_users_table
```

Use `--exit-code` instead of `--name` to fail CI when there's drift but write nothing. `--allow-empty` writes an empty file when the diff is clean.

### `migrate`

```sh
npx drizzle-pgkit-migrator migrate --migrations-dir src/db/migrations up
npx drizzle-pgkit-migrator migrate --migrations-dir src/db/migrations list
```

Everything after the migrator-level options is forwarded to `@pgkit/migrator`'s own CLI.

### `backfill`

```sh
npx drizzle-pgkit-migrator backfill --migrations-dir src/db/migrations
```

Marks every `.sql` file in `--migrations-dir` as already applied, copying the timestamps from `drizzle.__drizzle_migrations`.

## Programmatic API

Every command also has a typed function export:

```ts
import {
  generateSchemaSql,
  createMigration,
  createMigrator,
  backfillMigrations,
  pgCustomSQL,
} from "drizzle-pgkit-migrator";
```

## `pgCustomSQL`

Use this in your Drizzle schema to inject raw SQL into the generated `schema.sql`:

```ts
import { sql } from "drizzle-orm";
import { pgCustomSQL } from "drizzle-pgkit-migrator";

export const fuzzystrmatch = pgCustomSQL(
  sql`CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;`,
  { priority: -10 },
);

export const myTrigger = pgCustomSQL(
  sql`
    CREATE TRIGGER "MyTable_trigger"
    AFTER INSERT ON public."MyTable" FOR EACH ROW
    EXECUTE FUNCTION public.my_fn('id');
  `,
  { priority: 1 },
);
```

The Drizzle migration sits at priority `0`. Negative priorities are placed before the table definitions, non-negative after.
