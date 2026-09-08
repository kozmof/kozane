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
    // Index order of the layer on the canvas: a higher position stacks above a lower one.
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

/**
 * A saved place on a namespace's canvas. A warp holds the world coordinates of a view
 * centre, and the browser UI moves the viewport between them with the arrow keys. There
 * is no name column: warps are numbered by creation order, and uuidv7 ids already sort
 * that way.
 *
 * The index on `namespace_id` is spelled out because nothing else here implies one: the
 * namespace-scoped tables that carry a name get theirs from a unique index on
 * `(namespace_id, name)`, and a warp has no name to be unique in.
 */
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
    // A scope is intentionally cross-namespace. Do not add namespace_id here: a scope is
    // placed by what refers to it — scope_rel/card rows, and taskspace.scope_id — not by
    // a column, which is what lets one scope hold cards from several namespaces at once.
    //
    // That is not the same as every namespace seeing every scope. A board draws the scopes
    // `getScopesInNamespace` selects, and a namespace_id here would make that a column read
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

export const taskspaceTable = sqliteTable(
  "taskspace",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    // nullable, but nothing writes a null on the ordinary paths: `taskspace create` and
    // the HTTP route both resolve a namespace first, and `taskspace create` exits rather
    // than proceed without one. What lands here empty is a reattach — `taskspace scan
    // --apply --reattach` inserts from the on-disk marker, and a marker naming no namespace
    // ("namespaceId": "") gives a record with none. Such a record is unplaced rather than
    // another namespace's, which is why `getTaskspacesInNamespace` shows it on every board.
    // Cascade delete removes the record if the linked namespace is later deleted.
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
    /**
     * How wide the card is drawn, in canvas pixels. Nullable, and null is the ordinary
     * case: a card without one is drawn at `ui.defaultCardWidth` and keeps following that
     * setting as it changes. Only a card resized on the board pins a width of its own, so
     * widening every card is still one line of config rather than a pass over the table.
     */
    width: integer(),
    /**
     * Both timestamps carry a `DEFAULT 0` in the database that this declaration does not
     * mention. Migration 0011 needed one to add the columns NOT NULL to a table with rows
     * in it, and SQLite cannot drop a column default afterwards — the only way out is a
     * full table rebuild, which for `card` means `DROP TABLE` under a `PRAGMA
     * foreign_keys=OFF` that does nothing inside the migrator's transaction, cascading away
     * every `scope_rel` and `glue_rel` row. So the default stays.
     *
     * The writers name both columns themselves — `addCard` and `addCards` through
     * `newCardStamps`, the board's squash likewise, `db import` from the dump — so that the
     * two columns of one card, and every card of one batch, come from a single reading of
     * the clock. `$defaultFn` below is the backstop for an insert that names neither, and
     * is what keeps such an insert off the epoch; it is called once per column per row, so
     * it is not the thing to lean on where the two values have to agree.
     *
     * A raw `INSERT INTO card` bypasses both and takes the `DEFAULT 0`, landing at the
     * epoch instead of failing — so write them, as the fixtures in `test-utils/db.ts` and
     * the `db-json` tests do. `kozane doctor` reports the rows that got it wrong.
     */
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    /**
     * When the card's *text* last changed, and nothing else about it. A card dragged across
     * the board, resized, restacked, or moved to another partition or layer keeps the timestamp
     * it had — which is why `updateNamespaceCardPositions` and the `reassign*` writers do not
     * touch this column, and only `updateCard`'s content branch does.
     *
     * The board sends a position PATCH per drag. Were those to count, `updated_at` would
     * read "last moved" for most cards, and the interval `kozane card list --sort gap`
     * reports — how long a card stood before it was rewritten — would be reset by arranging
     * the board rather than by thinking on it.
     *
     * Text that arrives unchanged does not count either: `updateCard` reads the card and
     * compares before deciding, because the board's composer sends the textarea's contents
     * on every save whether or not a character of it was edited.
     */
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Read on every page load and on every snapshot poll, by `getCardDataByPartitions`: the board
    // asks for the cards of this namespace's partitions once a second for as long as a tab is
    // open. Without it SQLite answers that with a full scan of `card`, the largest table
    // here, per poll per tab.
    index("card_partition").on(t.partitionId),
    // `reassignLayerCards` selects by layer alone — deleting a layer moves its cards to the
    // default one, and the scan it would otherwise be is over every card in the workspace,
    // not just the layer's.
    index("card_layer").on(t.layerId),
    // `getCardChangeCounts` groups every card in the workspace by the day its text last
    // changed, which is what the map page's activity bands are drawn from. Without this it
    // is a full scan of `card` — the largest table — on every load of `/map`.
    //
    // Leading with `partition_id` because the query joins `partition` on it and groups by it, so
    // this covers the whole read rather than only the ordering: SQLite walks the index and
    // never touches the table. That also makes it a wider `card_partition`, so the two are not
    // redundant in the direction that matters — `card_partition` still answers the board's own
    // once-a-second read with a narrower index, and this one is not a substitute for it on a
    // path where every byte read is paid for per tab per second.
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
    // The primary key is `card_id`, which answers "what group is this card in" and nothing
    // else — and `dissolveOrphanGroups` asks the other question three times over: count the
    // members of these groups, select the ones left alone, delete them. Without this each of
    // those is a scan of the whole table, on the write path of every glue, unglue and card
    // delete. Same argument as `scope_rel_card` and `taskspace_scope`, on the table whose
    // reads are all on the far side of the key it has.
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
    // The primary key leads with `scope_id`, so it cannot answer a lookup by card — and
    // `getScopeRelsByCards` is exactly that, once per page load and once per snapshot poll.
    // Same argument as `taskspace_scope`, on the table that grows fastest.
    index("scope_rel_card").on(t.cardId),
  ],
);

// Relations enable the .query.* relational API (db.query.namespaceTable.findMany({ with: { partitions: true } }))

export const namespaceRelations = relations(namespaceTable, ({ many }) => ({
  partitions: many(partitionTable),
  layers: many(layerTable),
  warps: many(warpTable),
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
