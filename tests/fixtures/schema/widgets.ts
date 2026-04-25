import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { pgCustomSQL } from "../../../src/sql.js";

export const widgets = pgTable("Widgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const widgetsUpdatedAtTrigger = pgCustomSQL(
  sql`
    CREATE OR REPLACE FUNCTION "Widgets_setUpdatedAt"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW."updatedAt" := now();
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER "Widgets_setUpdatedAt_trg"
    BEFORE UPDATE ON "Widgets"
    FOR EACH ROW EXECUTE FUNCTION "Widgets_setUpdatedAt"();
  `,
  { priority: 1 },
);
