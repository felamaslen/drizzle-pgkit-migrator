import { sql } from "drizzle-orm";

import { pgCustomSQL } from "../../../src/sql.js";

export const citextExtension = pgCustomSQL(
  sql`CREATE EXTENSION IF NOT EXISTS citext;`,
  { priority: -10 },
);
