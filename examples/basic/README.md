# Example: basic

A self-contained example that uses every feature of `drizzle-pgkit-migrator` against a Postgres container.

## What it shows

- A Drizzle schema split across multiple files (`src/schema/users.ts`, `posts.ts`, `extensions.ts`).
- Two `pgCustomSQL` snippets — one with negative priority (a `CREATE EXTENSION` that must come before tables) and one with positive priority (a trigger that must come after).
- All four CLI subcommands wired up as npm scripts.
- A `src/programmatic.ts` script that drives the same workflow through the JS API.

## Prerequisites

- Docker (for `docker compose`)
- Node.js 20+

## Quick start

```sh
npm install
npm run db:up                  # start Postgres on localhost:5444

npm run db:generate            # write __generated__/schema.sql from the Drizzle schema
npm run db:create -- --name init   # write migrations/<timestamp>-init.sql
npm run db:migrate             # apply migrations to the running database
npm run db:migrate:list        # show applied / pending migrations
```

The Postgres container is exposed on **port 5444** to avoid colliding with a local Postgres install. The example reads `DATABASE_URL` and falls back to `postgres://example:example@localhost:5444/example`.

## Subsequent changes

After editing the Drizzle schema:

```sh
npm run db:create -- --name add_something
npm run db:migrate
```

To use the same flow as a CI drift check (no file written, non-zero exit on drift):

```sh
npm run db:drift
```

## Programmatic API

The same workflow without the CLI:

```sh
npm run programmatic
```

This calls `generateSchemaSql`, `createMigration`, `createMigrator().up()`, and `backfillMigrations` in sequence.

## `backfill`

`db:backfill` (and the `backfillMigrations` call in `programmatic.ts`) only does meaningful work when the database was previously migrated with `drizzle-kit` — it copies the `drizzle.__drizzle_migrations` history into the pgkit `migrator_internal.migrations` table so existing migrations are treated as already applied. On a fresh database it's a no-op.

## Tearing down

```sh
npm run db:down                # stop Postgres and delete the volume
```

## File layout

```
.
├── docker-compose.yml          # Postgres 18 on :5444
├── drizzle.config.ts           # used by `drizzle-kit` under the hood
├── src/
│   ├── schema/
│   │   ├── extensions.ts       # pgCustomSQL with priority -10
│   │   ├── users.ts            # pgEnum + pgTable
│   │   ├── posts.ts            # pgTable + pgCustomSQL with priority 1
│   │   └── index.ts
│   └── programmatic.ts         # JS API end-to-end demo
├── __generated__/schema.sql    # generated, desired-state SQL
└── migrations/                 # plain .sql files, applied by pgkit
```
