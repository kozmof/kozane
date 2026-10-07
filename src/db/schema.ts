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
import { PATH_KINDS } from "../lib/constants.js";

// Re-exported so `PathKind` still reads as a property of the column it types, for the
// callers that reach for it through the schema. Defined in `lib/constants` because
// `resolveTaskspacePath` needs it too and must not import the schema to get it.
export { PATH_KINDS, type PathKind } from "../lib/constants.js";

export const namespaceTable = sqliteTable(
  "namespace",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    name: text().notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("namespace_one_default")
      .on(t.isDefault)
      .where(sql`is_default = 1`),
  ],
);

export const partitionTable = sqliteTable(
  "partition",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaceTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("partition_one_default_per_namespace")
      .on(t.namespaceId)
      .where(sql`is_default = 1`),
    uniqueIndex("partition_name_per_namespace").on(t.namespaceId, t.name),
  ],
);

export const layerTable = sqliteTable(
  "layer",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaceTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    // Higher positions appear above lower ones.
    position: integer().notNull().default(0),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("layer_one_default_per_namespace")
      .on(t.namespaceId)
      .where(sql`is_default = 1`),
    uniqueIndex("layer_name_per_namespace").on(t.namespaceId, t.name),
  ],
);

/** Warps store coordinates and are numbered by creation order. Index them by namespace. */
export const warpTable = sqliteTable(
  "warp",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaceTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    posX: integer("pos_x").notNull().default(0),
    posY: integer("pos_y").notNull().default(0),
  },
  (t) => [index("warp_namespace").on(t.namespaceId)],
);

export const scopeTable = sqliteTable(
  "scope",
  {
    // Scopes can span namespaces. Memberships and taskspace links place them, so do not add
    // an owning namespace column. Boards use `getScopesInNamespace`, while the CLI can list
    // all workspace scopes.
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    name: text().notNull(),
  },
  (t) => [
    check("scope_name_nonempty", sql`length(${t.name}) > 0`),
    // Scope names are unique across the workspace. Namespaces can share a scope but cannot
    // create separate scopes with the same name.
    uniqueIndex("scope_name_unique").on(t.name),
  ],
);

/**
 * Scope frame geometry for one namespace's canvas. Store it separately because a shared scope
 * can have different frames on different boards.
 *
 * Membership remains in `scope_rel`. Browser overlap handling updates membership when cards
 * cross frame boundaries. Scopes without frames still work.
 */
export const scopeAreaTable = sqliteTable(
  "scope_area",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    scopeId: text("scope_id")
      .notNull()
      .references(() => scopeTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaceTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    posX: integer("pos_x").notNull().default(0),
    posY: integer("pos_y").notNull().default(0),
    width: integer().notNull(),
    height: integer().notNull(),
  },
  (t) => [
    // Allow multiple frames for one scope on a board. Lead the index with `scope_id` to
    // support checking for frames on one board or anywhere.
    index("scope_area_scope").on(t.scopeId, t.namespaceId),
    // Index frames by namespace for frequent polls.
    index("scope_area_namespace").on(t.namespaceId),
  ],
);

export const taskspaceTable = sqliteTable(
  "taskspace",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    // Normal creation resolves a namespace first. Reattaching a marker with an empty
    // namespace ID can create an unplaced taskspace, which appears on every board. Deleting a
    // linked namespace cascades to its taskspace records.
    namespaceId: text("namespace_id").references(() => namespaceTable.id, {
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
    pathKind: text("path_kind", { enum: PATH_KINDS }).notNull().default("workspace_relative"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // Read once per scope by `getScopesInNamespace`, which asks whether a scope has a
  // taskspace at all and whether it has one of this namespace. Without this the board's
  // once-a-second poll scans the whole table twice for every scope in the workspace.
  (t) => [index("taskspace_scope").on(t.scopeId)],
);

export const cardTable = sqliteTable(
  "card",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    partitionId: text("partition_id")
      .notNull()
      .references(() => partitionTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // Every card sits on exactly one layer of its namespace. Callers that omit it get the
    // namespace's default layer (see addCard).
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
    /** A null card width follows the configured default. */
    width: integer(),
    /**
     * Migration 0011 leaves `DEFAULT 0` on both database columns. Raw SQL inserts that omit
     * them therefore produce epoch timestamps, which `kozane doctor` reports.
     *
     * Application writers set both timestamps explicitly from one clock reading, and batch
     * writers share that reading across all rows. The `$defaultFn` is a fallback called
     * separately per column and row, so do not rely on it when timestamps must match.
     *
     * Removing the SQL default requires rebuilding `card`. Dropping that table with foreign
     * keys enabled would cascade into its relations, and foreign-key enforcement cannot be
     * disabled inside the migrator's transaction.
     */
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    /**
     * Time of the last text change. Position, width, stacking, partition, and layer changes
     * preserve it.
     *
     * `updateCard` compares content within the SQL update so saving unchanged text also
     * preserves the timestamp.
     */
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Index cards by partition to avoid full scans on page loads and polls.
    index("card_partition").on(t.partitionId),
    // Support `reassignLayerCards` lookup by layer when moving cards off a deleted layer.
    index("card_layer").on(t.layerId),
    // Cover the partition and update-time columns read by `getCardChangeCounts` for map
    // activity bands. Keep the narrower partition index for frequent board reads.
    index("card_partition_updated").on(t.partitionId, t.updatedAt),
  ],
);

export const glueTable = sqliteTable("glue", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
});
export const glueRelTable = sqliteTable(
  "glue_rel",
  {
    glueId: text("glue_id")
      .notNull()
      .references(() => glueTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    cardId: text("card_id")
      .primaryKey()
      .references(() => cardTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
  },
  (t) => [
    // Support group membership counts and cleanup by glue ID. The primary key only supports
    // lookup by card ID.
    index("glue_rel_glue").on(t.glueId),
  ],
);

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
  (t) => [
    primaryKey({ columns: [t.scopeId, t.cardId] }),
    // Support scope-relation lookup by card. The primary key begins with `scope_id`.
    index("scope_rel_card").on(t.cardId),
  ],
);

// Relations enable the .query.* relational API (db.query.namespaceTable.findMany({ with: { partitions: true } }))

export const namespaceRelations = relations(namespaceTable, ({ many }) => ({
  partitions: many(partitionTable),
  layers: many(layerTable),
  warps: many(warpTable),
  scopeAreas: many(scopeAreaTable),
}));

export const warpRelations = relations(warpTable, ({ one }) => ({
  namespace: one(namespaceTable, {
    fields: [warpTable.namespaceId],
    references: [namespaceTable.id],
  }),
}));

export const layerRelations = relations(layerTable, ({ one, many }) => ({
  namespace: one(namespaceTable, {
    fields: [layerTable.namespaceId],
    references: [namespaceTable.id],
  }),
  cards: many(cardTable),
}));

export const partitionRelations = relations(partitionTable, ({ one, many }) => ({
  namespace: one(namespaceTable, {
    fields: [partitionTable.namespaceId],
    references: [namespaceTable.id],
  }),
  cards: many(cardTable),
}));

export const cardRelations = relations(cardTable, ({ one, many }) => ({
  partition: one(partitionTable, {
    fields: [cardTable.partitionId],
    references: [partitionTable.id],
  }),
  layer: one(layerTable, { fields: [cardTable.layerId], references: [layerTable.id] }),
  // Deleting a taskspace sets the card's nullable taskspace reference to null.
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
  areas: many(scopeAreaTable),
}));

export const scopeAreaRelations = relations(scopeAreaTable, ({ one }) => ({
  scope: one(scopeTable, { fields: [scopeAreaTable.scopeId], references: [scopeTable.id] }),
  namespace: one(namespaceTable, {
    fields: [scopeAreaTable.namespaceId],
    references: [namespaceTable.id],
  }),
}));

export const taskspaceRelations = relations(taskspaceTable, ({ one, many }) => ({
  // Deleting a scope sets the taskspace's nullable scope reference to null.
  scope: one(scopeTable, { fields: [taskspaceTable.scopeId], references: [scopeTable.id] }),
  cards: many(cardTable),
}));

export const scopeRelRelations = relations(scopeRelTable, ({ one }) => ({
  scope: one(scopeTable, { fields: [scopeRelTable.scopeId], references: [scopeTable.id] }),
  card: one(cardTable, { fields: [scopeRelTable.cardId], references: [cardTable.id] }),
}));
