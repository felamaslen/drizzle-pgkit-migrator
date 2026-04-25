import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { pgCustomSQL } from "drizzle-pgkit-migrator";

import { users } from "./users.js";

export const posts = pgTable("Posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorId: uuid("authorId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Demonstrates a *positive-priority* `pgCustomSQL` snippet: this trigger
 * references the `Posts` table, so it must be created after drizzle-kit's
 * table output. Anything with `priority >= 0` is appended below the schema.
 */
export const postsUpdatedAtTrigger = pgCustomSQL(
  sql`
    CREATE OR REPLACE FUNCTION "Posts_setUpdatedAt"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW."updatedAt" := now();
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER "Posts_setUpdatedAt_trg"
    BEFORE UPDATE ON "Posts"
    FOR EACH ROW EXECUTE FUNCTION "Posts_setUpdatedAt"();
  `,
  { priority: 1 },
);
