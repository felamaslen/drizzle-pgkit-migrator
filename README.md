# drizzle-pg-kit-migrator

CLI glue between [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) and [`@pgkit/migrator`](https://www.npmjs.com/package/@pgkit/migrator) / [`@pgkit/migra`](https://www.npmjs.com/package/@pgkit/migra).

It lets you keep authoring your schema in Drizzle while running migrations with pgkit:

1. **`generate-schema`** — turns your Drizzle schema (plus optional raw-SQL snippets) into a single `schema.sql` describing the desired state.
2. **`create`** — spins up two throwaway databases (one from `schema.sql`, one from your existing migrations) and uses `@pgkit/migra` to write a new migration containing the diff.
3. **`migrate up|down|list|...`** — runs `@pgkit/migrator` against your real database. Subcommands and flags are forwarded to pgkit's own CLI.
4. **`backfill`** — for repos switching off `drizzle-kit` migrations: copies the existing `drizzle.__drizzle_migrations` history into the pgkit migrations table so they're treated as already applied.

## Install

```sh
npm install --save-dev drizzle-pg-kit-migrator drizzle-kit
```

## CLI

```sh
npx drizzle-pg-kit-migrator <command> [options]
```

All commands accept `--database-url` (or read `DATABASE_URL` from the environment).

### `generate-schema`

```sh
npx drizzle-pg-kit-migrator generate-schema \
  --schema-dir src/db/schema \
  --schema-file src/db/__generated__/schema.sql
```

Runs `drizzle-kit generate` into a temp dir, then weaves in any `pgCustomSQL` snippets exported from your schema files (sorted by `priority` — negative goes before tables, positive goes after).

### `create`

```sh
npx drizzle-pg-kit-migrator create \
  --schema-file src/db/__generated__/schema.sql \
  --migrations-dir src/db/migrations \
  --name add_users_table
```

Use `--exit-code` instead of `--name` to fail CI when there's drift but write nothing. `--allow-empty` writes an empty file when the diff is clean.

### `migrate`

```sh
npx drizzle-pg-kit-migrator migrate --migrations-dir src/db/migrations up
npx drizzle-pg-kit-migrator migrate --migrations-dir src/db/migrations list
npx drizzle-pg-kit-migrator migrate --migrations-dir src/db/migrations down --to <name>
```

Everything after the migrator-level options is forwarded to `@pgkit/migrator`'s own CLI.

### `backfill`

```sh
npx drizzle-pg-kit-migrator backfill --migrations-dir src/db/migrations
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
} from "drizzle-pg-kit-migrator";
```

## `pgCustomSQL`

Use this in your Drizzle schema to inject raw SQL into the generated `schema.sql`:

```ts
import { sql } from "drizzle-orm";
import { pgCustomSQL } from "drizzle-pg-kit-migrator";

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
