import { relations } from "drizzle-orm";
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { v7 as uuidv7 } from "uuid";

export const projectTable = sqliteTable("project", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  name: text().notNull(),
});

export const bundleTable = sqliteTable("bundle", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  projectId: text("project_id")
    .notNull()
    .references(() => projectTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  name: text().notNull(),
});

export const scopeTable = sqliteTable("scope", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  name: text().notNull().default(""),
});

export const workingCopyTable = sqliteTable("working_copy", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  scopeId: text("scope_id").references(() => scopeTable.id, {
    // When scopeId is deleted, workingCopy is retained but set to null.
    onDelete: "set null",
    onUpdate: "cascade",
  }),
  name: text().notNull().default(""),
  dirPath: text("dir_path"),
});

export const cardTable = sqliteTable("card", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => bundleTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  workingCopyId: text("working_copy_id").references(() => workingCopyTable.id, {
    // When workingCopyId is deleted, card is retained but set to null.
    onDelete: "set null",
    onUpdate: "cascade",
  }),
  content: text().notNull(),
  posX: integer("pos_x").notNull().default(0),
  posY: integer("pos_y").notNull().default(0),
});

export const tieTable = sqliteTable("tie", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  fromCardId: text("from_card_id")
    .notNull()
    .references(() => cardTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  toCardId: text("to_card_id")
    .notNull()
    .references(() => cardTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  relType: text("rel_type"),
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

// Relations enable the .query.* relational API (db.query.projectTable.findMany({ with: { bundles: true } }))

export const projectRelations = relations(projectTable, ({ many }) => ({
  bundles: many(bundleTable),
}));

export const bundleRelations = relations(bundleTable, ({ one, many }) => ({
  project: one(projectTable, { fields: [bundleTable.projectId], references: [projectTable.id] }),
  cards: many(cardTable),
}));

export const cardRelations = relations(cardTable, ({ one, many }) => ({
  bundle: one(bundleTable, { fields: [cardTable.bundleId], references: [bundleTable.id] }),
  // nullable: card retains its row when its working copy is deleted (onDelete: "set null")
  workingCopy: one(workingCopyTable, {
    fields: [cardTable.workingCopyId],
    references: [workingCopyTable.id],
  }),
  scopeRels: many(scopeRelTable),
  tiesFrom: many(tieTable, { relationName: "tiesFrom" }),
  tiesTo: many(tieTable, { relationName: "tiesTo" }),
}));

export const tieRelations = relations(tieTable, ({ one }) => ({
  fromCard: one(cardTable, {
    fields: [tieTable.fromCardId],
    references: [cardTable.id],
    relationName: "tiesFrom",
  }),
  toCard: one(cardTable, {
    fields: [tieTable.toCardId],
    references: [cardTable.id],
    relationName: "tiesTo",
  }),
}));

export const scopeRelations = relations(scopeTable, ({ many }) => ({
  // scopes are cross-project; ownership is expressed through scopeRel, not a direct FK
  workingCopies: many(workingCopyTable),
  scopeRels: many(scopeRelTable),
}));

export const workingCopyRelations = relations(workingCopyTable, ({ one, many }) => ({
  // nullable: working copy is retained as an orphan when its scope is deleted (onDelete: "set null")
  scope: one(scopeTable, { fields: [workingCopyTable.scopeId], references: [scopeTable.id] }),
  cards: many(cardTable),
}));

export const scopeRelRelations = relations(scopeRelTable, ({ one }) => ({
  scope: one(scopeTable, { fields: [scopeRelTable.scopeId], references: [scopeTable.id] }),
  card: one(cardTable, { fields: [scopeRelTable.cardId], references: [cardTable.id] }),
}));
