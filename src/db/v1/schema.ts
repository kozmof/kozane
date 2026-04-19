import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";
import { genUUID } from "../internal/uuid.js";

export const projectTable = sqliteTable("project", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => genUUID()),
  name: text().notNull(),
});

export const bundleTable = sqliteTable("bundle", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => genUUID()),
  projectId: text("project_id")
    .notNull()
    .references(() => projectTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  name: text().notNull(),
});

export const scopeTable = sqliteTable("scope", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => genUUID()),
});

export const workingCopyTable = sqliteTable("working_copy", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => genUUID()),
  scopeId: text("scope_id")
    .references(() => scopeTable.id, { onDelete: "set null", onUpdate: "cascade" }),
});

export const cardTable = sqliteTable("card", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => genUUID()),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => bundleTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  workingCopyId: text("working_copy_id").references(() => workingCopyTable.id, { onDelete: 'set null', onUpdate: "cascade"}),
  content: text().notNull(),
});

export const scopeRelTable = sqliteTable(
  "scope_rel",
  {
    scopeId: text("scope_id")
      .notNull()
      .references(() => scopeTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    cardId: text("card_id")
      .notNull()
      .references(() => cardTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.scopeId, t.cardId] })],
);
