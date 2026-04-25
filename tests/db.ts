import { randomUUID } from "node:crypto";

import pg from "pg";

const ADMIN_URL =
  process.env.DATABASE_URL ??
  "postgres://dpkmtest:dpkmtest@localhost:5455/dpkmtest";

/**
 * Create a uniquely-named database and return a connection string for it.
 * Each test gets its own database so they're trivially isolated.
 */
export async function createTempDatabase(): Promise<{
  url: string;
  drop: () => Promise<void>;
}> {
  const name = `test_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  } finally {
    await admin.end();
  }

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;

  return {
    url: url.toString(),
    drop: async () => {
      const adminPool = new pg.Pool({ connectionString: ADMIN_URL });
      try {
        // Disconnect any lingering sessions before dropping.
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name],
        );
        await adminPool.query(
          `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`,
        );
      } finally {
        await adminPool.end();
      }
    },
  };
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  url: string,
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    return await pool.query<T>(sql, params);
  } finally {
    await pool.end();
  }
}
