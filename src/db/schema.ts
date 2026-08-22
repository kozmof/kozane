import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  uniqueIndex,
  check,
} from "drizzle-orm/sqlite-core";
import { v7 as uuidv7 } from "uuid";

export const projectTable = sqliteTable(
  "project",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    name: text().notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("project_one_default")
      .on(t.isDefault)
      .where(sql`is_default = 1`),
  ],
);

export const bundleTable = sqliteTable(
  "bundle",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("bundle_one_default_per_project")
      .on(t.projectId)
      .where(sql`is_default = 1`),
    uniqueIndex("bundle_name_per_project").on(t.projectId, t.name),
  ],
);

export const layerTable = sqliteTable(
  "layer",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    // Index order of the layer on the canvas: a higher position stacks above a lower one.
    position: integer().notNull().default(0),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("layer_one_default_per_project")
      .on(t.projectId)
      .where(sql`is_default = 1`),
    uniqueIndex("layer_name_per_project").on(t.projectId, t.name),
  ],
);

/**
 * A saved place on a project's canvas. A warp holds the world coordinates of a view
 * centre, and the browser UI moves the viewport between them with the arrow keys. There
 * is no name column: warps are numbered by creation order, and uuidv7 ids already sort
 * that way.
 *
 * The index on `project_id` is spelled out because nothing else here implies one: the
 * project-scoped tables that carry a name get theirs from a unique index on
 * `(project_id, name)`, and a warp has no name to be unique in.
 */
export const warpTable = sqliteTable(
  "warp",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    posX: integer("pos_x").notNull().default(0),
    posY: integer("pos_y").notNull().default(0),
  },
  (t) => [index("warp_project").on(t.projectId)],
);

export const scopeTable = sqliteTable(
  "scope",
  {
    // A scope is intentionally cross-project. Do not add project_id here: a scope is
    // placed by what refers to it — scope_rel/card rows, and taskspace.scope_id — not by
    // a column, which is what lets one scope hold cards from several projects at once.
    //
    // That is not the same as every project seeing every scope. A board draws the scopes
    // `getScopesInProject` selects, and a project_id here would make that a column read
    // but would also make a shared scope impossible. The CLI keeps the workspace-wide
    // view (`kozane scope list`).
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    name: text().notNull(),
  },
  (t) => [
    check("scope_name_nonempty", sql`length(${t.name}) > 0`),
    uniqueIndex("scope_name_unique").on(t.name),
  ],
);

export const PATH_KINDS = ["project_relative", "absolute"] as const;
export type PathKind = (typeof PATH_KINDS)[number];

export const taskspaceTable = sqliteTable(
  "taskspace",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    // nullable, but nothing writes a null on the ordinary paths: `taskspace create` and
    // the HTTP route both resolve a project first, and `taskspace create` exits rather
    // than proceed without one. What lands here empty is a reattach — `taskspace scan
    // --apply --reattach` inserts from the on-disk marker, and a marker naming no project
    // ("projectId": "") gives a record with none. Such a record is unplaced rather than
    // another project's, which is why `getTaskspacesInProject` shows it on every board.
    // Cascade delete removes the record if the linked project is later deleted.
    projectId: text("project_id").references(() => projectTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    scopeId: text("scope_id").references(() => scopeTable.id, {
      // When scopeId is deleted, taskspace is retained but set to null.
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    name: text().notNull().default(""),
    path: text("path"),
    pathKind: text("path_kind", { enum: PATH_KINDS }).notNull().default("project_relative"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // Read once per scope by `getScopesInProject`, which asks whether a scope has a
  // taskspace at all and whether it has one of this project. Without this the board's
  // once-a-second poll scans the whole table twice for every scope in the workspace.
  (t) => [index("taskspace_scope").on(t.scopeId)],
);

export const cardTable = sqliteTable("card", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => bundleTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  // Every card sits on exactly one layer of its project. Callers that omit it get the
  // project's default layer (see addCard).
  layerId: text("layer_id")
    .notNull()
    .references(() => layerTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  taskspaceId: text("taskspace_id").references(() => taskspaceTable.id, {
    // When taskspaceId is deleted, card is retained but set to null.
    onDelete: "set null",
    onUpdate: "cascade",
  }),
  content: text().notNull(),
  posX: integer("pos_x").notNull().default(0),
  posY: integer("pos_y").notNull().default(0),
  zIndex: integer("z_index").notNull().default(0),
  /**
   * How wide the card is drawn, in canvas pixels. Nullable, and null is the ordinary
   * case: a card without one is drawn at `ui.defaultCardWidth` and keeps following that
   * setting as it changes. Only a card resized on the board pins a width of its own, so
   * widening every card is still one line of config rather than a pass over the table.
   */
  width: integer(),
});

export const glueTable = sqliteTable("glue", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
});
export const glueRelTable = sqliteTable("glue_rel", {
  glueId: text("glue_id")
    .notNull()
    .references(() => glueTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  cardId: text("card_id")
    .primaryKey()
    .references(() => cardTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
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
  layers: many(layerTable),
  warps: many(warpTable),
}));

export const warpRelations = relations(warpTable, ({ one }) => ({
  project: one(projectTable, { fields: [warpTable.projectId], references: [projectTable.id] }),
}));

export const layerRelations = relations(layerTable, ({ one, many }) => ({
  project: one(projectTable, { fields: [layerTable.projectId], references: [projectTable.id] }),
  cards: many(cardTable),
}));

export const bundleRelations = relations(bundleTable, ({ one, many }) => ({
  project: one(projectTable, { fields: [bundleTable.projectId], references: [projectTable.id] }),
  cards: many(cardTable),
}));

export const cardRelations = relations(cardTable, ({ one, many }) => ({
  bundle: one(bundleTable, { fields: [cardTable.bundleId], references: [bundleTable.id] }),
  layer: one(layerTable, { fields: [cardTable.layerId], references: [layerTable.id] }),
  // nullable: card retains its row when its taskspace is deleted (onDelete: "set null")
  taskspace: one(taskspaceTable, {
    fields: [cardTable.taskspaceId],
    references: [taskspaceTable.id],
  }),
  scopeRels: many(scopeRelTable),
  glueRels: many(glueRelTable),
}));

export const glueRelations = relations(glueTable, ({ many }) => ({
  glueRels: many(glueRelTable),
}));

export const glueRelRelations = relations(glueRelTable, ({ one }) => ({
  glue: one(glueTable, { fields: [glueRelTable.glueId], references: [glueTable.id] }),
  card: one(cardTable, { fields: [glueRelTable.cardId], references: [cardTable.id] }),
}));

export const scopeRelations = relations(scopeTable, ({ many }) => ({
  taskspaces: many(taskspaceTable),
  scopeRels: many(scopeRelTable),
}));

export const taskspaceRelations = relations(taskspaceTable, ({ one, many }) => ({
  // nullable: taskspace is retained as an orphan when its scope is deleted (onDelete: "set null")
  scope: one(scopeTable, { fields: [taskspaceTable.scopeId], references: [scopeTable.id] }),
  cards: many(cardTable),
}));

export const scopeRelRelations = relations(scopeRelTable, ({ one }) => ({
  scope: one(scopeTable, { fields: [scopeRelTable.scopeId], references: [scopeTable.id] }),
  card: one(cardTable, { fields: [scopeRelTable.cardId], references: [cardTable.id] }),
}));
