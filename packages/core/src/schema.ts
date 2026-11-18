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
import { PATH_KINDS } from "./constants/workspace.js";

// Preserve schema exports without loading runtime compatibility entries during code generation.
// Path resolution shares these definitions without importing the database schema.
export { PATH_KINDS, type PathKind } from "./constants/workspace.js";

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

/**
 * A grid of slots a namespace's cards can be stored in. The board draws it as an icon at
 * `posX`/`posY` that opens to show the grid. Cards sit in the grid one per slot. See
 * `card.inventory_slot`.
 */
export const inventoryTable = sqliteTable(
  "inventory",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaceTable.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull().default(""),
    posX: integer("pos_x").notNull().default(0),
    posY: integer("pos_y").notNull().default(0),
  },
  (t) => [index("inventory_namespace").on(t.namespaceId)],
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
      // Deleting a scope preserves the taskspace and clears its scope reference.
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    name: text().notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // Support `getScopesInNamespace` lookups for any linked taskspace and for one in this
  // namespace. Without this index, each board poll scans the taskspace table twice per scope.
  (t) => [index("taskspace_scope").on(t.scopeId)],
);

/** Device-local attachments survive shared taskspace deletion and restoration. */
export const taskspaceLocalTable = sqliteTable("taskspace_local", {
  // Deliberately no FK. Metadata for absent taskspaces remains available to local recovery.
  taskspaceId: text("taskspace_id").primaryKey().notNull(),
  path: text("path"),
  pathKind: text("path_kind", { enum: PATH_KINDS }).notNull().default("workspace_relative"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
});

/** Local filesystem intent and completion evidence, retained independently of shared rows. */
export const localFileOperationTable = sqliteTable(
  "local_file_operation",
  {
    id: text("id").primaryKey().notNull(),
    kind: text("kind", {
      enum: ["taskspace.claim", "taskspace.file", "taskspace.directory"],
    }).notNull(),
    version: integer("version").notNull(),
    taskspaceId: text("taskspace_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    path: text("path").notNull(),
    pathKind: text("path_kind", { enum: PATH_KINDS }).notNull(),
    state: text("state", { enum: ["pending", "confirmed", "abandoned"] }).notNull(),
    intent: text("intent").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
    error: text("error"),
    abandonedAt: integer("abandoned_at", { mode: "timestamp" }),
    abandonReason: text("abandon_reason"),
  },
  (t) => [
    index("local_file_operation_state").on(t.state),
    check(
      "local_file_operation_kind",
      sql`${t.kind} IN ('taskspace.claim', 'taskspace.file', 'taskspace.directory') AND ${t.version} = 1`,
    ),
    check(
      "local_file_operation_path_kind",
      sql`${t.pathKind} IN ('workspace_relative', 'absolute')`,
    ),
    check(
      "local_file_operation_state",
      sql`(${t.state} = 'pending' AND ${t.confirmedAt} IS NULL AND ${t.abandonedAt} IS NULL AND ${t.abandonReason} IS NULL) OR (${t.state} = 'confirmed' AND ${t.confirmedAt} IS NOT NULL AND ${t.error} IS NULL AND ${t.abandonedAt} IS NULL AND ${t.abandonReason} IS NULL) OR (${t.state} = 'abandoned' AND ${t.confirmedAt} IS NULL AND ${t.abandonedAt} IS NOT NULL AND ${t.abandonReason} IS NOT NULL AND length(trim(${t.abandonReason})) > 0)`,
    ),
  ],
);

/** Local upload pins survive failed publication and shared row restoration. */
export const localImageUploadTable = sqliteTable(
  "local_image_upload",
  {
    filename: text("filename").primaryKey().notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    state: text("state", { enum: ["pending", "installed", "completed", "abandoned"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    installedAt: integer("installed_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    error: text("error"),
    abandonedAt: integer("abandoned_at", { mode: "timestamp" }),
    abandonReason: text("abandon_reason"),
  },
  (t) => [
    index("local_image_upload_state").on(t.state),
    check(
      "local_image_upload_name",
      sql`length(${t.filename}) IN (40,41) AND substr(${t.filename},37,1)='.' AND substr(${t.filename},1,36) NOT GLOB '*[^a-f0-9-]*' AND substr(${t.filename},38) IN ('jpg','jpeg','png','svg')`,
    ),
    check(
      "local_image_upload_bytes",
      sql`typeof(${t.byteLength})='integer' AND ${t.byteLength} BETWEEN 1 AND 10485760 AND length(${t.sha256})=64 AND ${t.sha256} NOT GLOB '*[^a-f0-9]*'`,
    ),
    check(
      "local_image_upload_state",
      sql`(${t.state}='pending' AND ${t.installedAt} IS NULL AND ${t.completedAt} IS NULL AND ${t.abandonedAt} IS NULL AND ${t.abandonReason} IS NULL) OR (${t.state}='installed' AND ${t.installedAt} IS NOT NULL AND ${t.completedAt} IS NULL AND ${t.error} IS NULL AND ${t.abandonedAt} IS NULL AND ${t.abandonReason} IS NULL) OR (${t.state}='completed' AND ${t.installedAt} IS NOT NULL AND ${t.completedAt} IS NOT NULL AND ${t.error} IS NULL AND ${t.abandonedAt} IS NULL AND ${t.abandonReason} IS NULL) OR (${t.state}='abandoned' AND ${t.completedAt} IS NULL AND ${t.abandonedAt} IS NOT NULL AND ${t.abandonReason} IS NOT NULL AND length(trim(${t.abandonReason})) > 0)`,
    ),
  ],
);

/** Device-local owners retain manifests independently of shared rows and selections. */
export const localAssetManifestTable = sqliteTable(
  "local_asset_manifest",
  {
    ownerKind: text("owner_kind", {
      enum: ["baseline", "effect-set", "pending-work", "transfer", "recovery"],
    }).notNull(),
    ownerId: text("owner_id").notNull(),
    manifest: text("manifest").notNull(),
    state: text("state", { enum: ["pending", "retained", "released"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp" }),
    releasedAt: integer("released_at", { mode: "timestamp" }),
    releaseReason: text("release_reason"),
  },
  (t) => [
    primaryKey({ columns: [t.ownerKind, t.ownerId] }),
    index("local_asset_manifest_state").on(t.state),
    check(
      "local_asset_manifest_owner",
      sql`${t.ownerKind} IN ('baseline','effect-set','pending-work','transfer','recovery') AND length(trim(${t.ownerId})) BETWEEN 1 AND 1000 AND instr(${t.ownerId},char(0))=0`,
    ),
    check("local_asset_manifest_json", sql`json_valid(${t.manifest})`),
    check(
      "local_asset_manifest_state",
      sql`(${t.state}='pending' AND ${t.verifiedAt} IS NULL AND ${t.releasedAt} IS NULL AND ${t.releaseReason} IS NULL) OR (${t.state}='retained' AND ${t.verifiedAt} IS NOT NULL AND ${t.releasedAt} IS NULL AND ${t.releaseReason} IS NULL) OR (${t.state}='released' AND ${t.releasedAt} IS NOT NULL AND ${t.releaseReason} IS NOT NULL AND length(trim(${t.releaseReason})) > 0)`,
    ),
  ],
);

/** Trusted checkpoint descriptors are local bookkeeping, independent of shared rows and file pins. */
export const localRecoveryCheckpointTable = sqliteTable(
  "local_recovery_checkpoint",
  {
    workspaceId: text("workspace_id").notNull(),
    deviceId: text("device_id").notNull(),
    epochId: text("epoch_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    descriptor: text("descriptor").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.deviceId, t.epochId, t.checkpointId] }),
    check(
      "local_recovery_checkpoint_identity",
      sql`length(trim(${t.workspaceId})) BETWEEN 1 AND 1000 AND instr(${t.workspaceId},char(0))=0 AND length(trim(${t.deviceId})) BETWEEN 1 AND 1000 AND instr(${t.deviceId},char(0))=0 AND length(trim(${t.epochId})) BETWEEN 1 AND 1000 AND instr(${t.epochId},char(0))=0 AND length(trim(${t.checkpointId})) BETWEEN 1 AND 1000 AND instr(${t.checkpointId},char(0))=0`,
    ),
    check(
      "local_recovery_checkpoint_descriptor",
      sql`json_valid(${t.descriptor}) AND json_type(${t.descriptor},'$.version') IS 'integer' AND json_extract(${t.descriptor},'$.version') IS 1 AND json_extract(${t.descriptor},'$.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.descriptor},'$.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.descriptor},'$.identity.epochId') IS ${t.epochId} AND json_extract(${t.descriptor},'$.identity.checkpointId') IS ${t.checkpointId}`,
    ),
  ],
);

/** Trusted shared-history descriptors retain the original local checkpoint binding. */
export const localRecoverySharedHistoryTable = sqliteTable(
  "local_recovery_shared_history",
  {
    workspaceId: text("workspace_id").notNull(),
    deviceId: text("device_id").notNull(),
    epochId: text("epoch_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    descriptor: text("descriptor").notNull(),
    localDescriptor: text("local_descriptor").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.deviceId, t.epochId, t.checkpointId] }),
    check(
      "local_recovery_shared_history_identity",
      sql`length(trim(${t.workspaceId})) BETWEEN 1 AND 1000 AND instr(${t.workspaceId},char(0))=0 AND length(trim(${t.deviceId})) BETWEEN 1 AND 1000 AND instr(${t.deviceId},char(0))=0 AND length(trim(${t.epochId})) BETWEEN 1 AND 1000 AND instr(${t.epochId},char(0))=0 AND length(trim(${t.checkpointId})) BETWEEN 1 AND 1000 AND instr(${t.checkpointId},char(0))=0`,
    ),
    check(
      "local_recovery_shared_history_descriptor",
      sql`json_valid(${t.descriptor}) AND json_type(${t.descriptor},'$.version') IS 'integer' AND json_extract(${t.descriptor},'$.version') IS 1 AND json_extract(${t.descriptor},'$.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.descriptor},'$.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.descriptor},'$.identity.epochId') IS ${t.epochId} AND json_extract(${t.descriptor},'$.identity.checkpointId') IS ${t.checkpointId}`,
    ),
    check(
      "local_recovery_shared_history_local_descriptor",
      sql`json_valid(${t.localDescriptor}) AND json_type(${t.localDescriptor},'$.version') IS 'integer' AND json_extract(${t.localDescriptor},'$.version') IS 1 AND json_extract(${t.localDescriptor},'$.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.localDescriptor},'$.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.localDescriptor},'$.identity.epochId') IS ${t.epochId} AND json_extract(${t.localDescriptor},'$.identity.checkpointId') IS ${t.checkpointId} AND json_extract(${t.localDescriptor},'$.identity.schemaId') IS json_extract(${t.descriptor},'$.identity.schemaId')`,
    ),
  ],
);

/** Trusted asset descriptors preserve the exact original shared and local checkpoint pair. */
export const localRecoveryAssetsTable = sqliteTable(
  "local_recovery_assets",
  {
    workspaceId: text("workspace_id").notNull(),
    deviceId: text("device_id").notNull(),
    epochId: text("epoch_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    descriptor: text("descriptor").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.deviceId, t.epochId, t.checkpointId] }),
    check(
      "local_recovery_assets_identity",
      sql`length(trim(${t.workspaceId})) BETWEEN 1 AND 1000 AND instr(${t.workspaceId},char(0))=0 AND length(trim(${t.deviceId})) BETWEEN 1 AND 1000 AND instr(${t.deviceId},char(0))=0 AND length(trim(${t.epochId})) BETWEEN 1 AND 1000 AND instr(${t.epochId},char(0))=0 AND length(trim(${t.checkpointId})) BETWEEN 1 AND 1000 AND instr(${t.checkpointId},char(0))=0`,
    ),
    check(
      "local_recovery_assets_descriptor",
      sql`json_valid(${t.descriptor}) AND json_type(${t.descriptor},'$.version') IS 'integer' AND json_extract(${t.descriptor},'$.version') IS 1 AND json_type(${t.descriptor},'$.binding.checkpoint.version') IS 'integer' AND json_extract(${t.descriptor},'$.binding.checkpoint.version') IS 1 AND json_type(${t.descriptor},'$.binding.localCheckpoint.version') IS 'integer' AND json_extract(${t.descriptor},'$.binding.localCheckpoint.version') IS 1 AND json_extract(${t.descriptor},'$.binding.checkpoint.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.descriptor},'$.binding.checkpoint.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.descriptor},'$.binding.checkpoint.identity.epochId') IS ${t.epochId} AND json_extract(${t.descriptor},'$.binding.checkpoint.identity.checkpointId') IS ${t.checkpointId} AND json_extract(${t.descriptor},'$.binding.localCheckpoint.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.descriptor},'$.binding.localCheckpoint.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.descriptor},'$.binding.localCheckpoint.identity.epochId') IS ${t.epochId} AND json_extract(${t.descriptor},'$.binding.localCheckpoint.identity.checkpointId') IS ${t.checkpointId} AND json_extract(${t.descriptor},'$.binding.localCheckpoint.identity.schemaId') IS json_extract(${t.descriptor},'$.binding.checkpoint.identity.schemaId')`,
    ),
  ],
);

/** Execution expectations retain the original local descriptor alongside their shared content binding. */
export const localRecoveryExecutionsTable = sqliteTable(
  "local_recovery_executions",
  {
    workspaceId: text("workspace_id").notNull(),
    deviceId: text("device_id").notNull(),
    epochId: text("epoch_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    descriptor: text("descriptor").notNull(),
    localDescriptor: text("local_descriptor").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.deviceId, t.epochId, t.checkpointId] }),
    check(
      "local_recovery_executions_identity",
      sql`length(trim(${t.workspaceId})) BETWEEN 1 AND 1000 AND instr(${t.workspaceId},char(0))=0 AND length(trim(${t.deviceId})) BETWEEN 1 AND 1000 AND instr(${t.deviceId},char(0))=0 AND length(trim(${t.epochId})) BETWEEN 1 AND 1000 AND instr(${t.epochId},char(0))=0 AND length(trim(${t.checkpointId})) BETWEEN 1 AND 1000 AND instr(${t.checkpointId},char(0))=0`,
    ),
    check(
      "local_recovery_executions_descriptor",
      sql`json_valid(${t.descriptor}) AND json_type(${t.descriptor},'$.version') IS 'integer' AND json_extract(${t.descriptor},'$.version') IS 1 AND json_type(${t.descriptor},'$.checkpoint.version') IS 'integer' AND json_extract(${t.descriptor},'$.checkpoint.version') IS 1 AND json_extract(${t.descriptor},'$.checkpoint.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.descriptor},'$.checkpoint.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.descriptor},'$.checkpoint.identity.epochId') IS ${t.epochId} AND json_extract(${t.descriptor},'$.checkpoint.identity.checkpointId') IS ${t.checkpointId}`,
    ),
    check(
      "local_recovery_executions_local_descriptor",
      sql`json_valid(${t.localDescriptor}) AND json_type(${t.localDescriptor},'$.version') IS 'integer' AND json_extract(${t.localDescriptor},'$.version') IS 1 AND json_extract(${t.localDescriptor},'$.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.localDescriptor},'$.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.localDescriptor},'$.identity.epochId') IS ${t.epochId} AND json_extract(${t.localDescriptor},'$.identity.checkpointId') IS ${t.checkpointId} AND json_extract(${t.localDescriptor},'$.identity.schemaId') IS json_extract(${t.descriptor},'$.checkpoint.identity.schemaId')`,
    ),
  ],
);

/** Original-action expectations retain the original local descriptor alongside execution and shared bindings. */
export const localRecoveryActionsTable = sqliteTable(
  "local_recovery_actions",
  {
    workspaceId: text("workspace_id").notNull(),
    deviceId: text("device_id").notNull(),
    epochId: text("epoch_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    descriptor: text("descriptor").notNull(),
    localDescriptor: text("local_descriptor").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.deviceId, t.epochId, t.checkpointId] }),
    check(
      "local_recovery_actions_identity",
      sql`length(trim(${t.workspaceId})) BETWEEN 1 AND 1000 AND instr(${t.workspaceId},char(0))=0 AND length(trim(${t.deviceId})) BETWEEN 1 AND 1000 AND instr(${t.deviceId},char(0))=0 AND length(trim(${t.epochId})) BETWEEN 1 AND 1000 AND instr(${t.epochId},char(0))=0 AND length(trim(${t.checkpointId})) BETWEEN 1 AND 1000 AND instr(${t.checkpointId},char(0))=0`,
    ),
    check(
      "local_recovery_actions_descriptor",
      sql`json_valid(${t.descriptor}) AND json_type(${t.descriptor},'$.version') IS 'integer' AND json_extract(${t.descriptor},'$.version') IS 1 AND json_type(${t.descriptor},'$.checkpoint.version') IS 'integer' AND json_extract(${t.descriptor},'$.checkpoint.version') IS 1 AND json_type(${t.descriptor},'$.checkpoint.checkpoint.version') IS 'integer' AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.version') IS 1 AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.identity.epochId') IS ${t.epochId} AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.identity.checkpointId') IS ${t.checkpointId}`,
    ),
    check(
      "local_recovery_actions_local_descriptor",
      sql`json_valid(${t.localDescriptor}) AND json_type(${t.localDescriptor},'$.version') IS 'integer' AND json_extract(${t.localDescriptor},'$.version') IS 1 AND json_extract(${t.localDescriptor},'$.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.localDescriptor},'$.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.localDescriptor},'$.identity.epochId') IS ${t.epochId} AND json_extract(${t.localDescriptor},'$.identity.checkpointId') IS ${t.checkpointId} AND json_extract(${t.localDescriptor},'$.identity.schemaId') IS json_extract(${t.descriptor},'$.checkpoint.checkpoint.identity.schemaId')`,
    ),
  ],
);

/** Retained-history expectations retain the original local descriptor and all nested source bindings. */
export const localRecoveryRetainedHistoryTable = sqliteTable(
  "local_recovery_retained_history",
  {
    workspaceId: text("workspace_id").notNull(),
    deviceId: text("device_id").notNull(),
    epochId: text("epoch_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    descriptor: text("descriptor").notNull(),
    localDescriptor: text("local_descriptor").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.deviceId, t.epochId, t.checkpointId] }),
    check(
      "local_recovery_retained_history_identity",
      sql`length(trim(${t.workspaceId})) BETWEEN 1 AND 1000 AND instr(${t.workspaceId},char(0))=0 AND length(trim(${t.deviceId})) BETWEEN 1 AND 1000 AND instr(${t.deviceId},char(0))=0 AND length(trim(${t.epochId})) BETWEEN 1 AND 1000 AND instr(${t.epochId},char(0))=0 AND length(trim(${t.checkpointId})) BETWEEN 1 AND 1000 AND instr(${t.checkpointId},char(0))=0`,
    ),
    check(
      "local_recovery_retained_history_descriptor",
      sql`json_valid(${t.descriptor}) AND json_type(${t.descriptor},'$.version') IS 'integer' AND json_extract(${t.descriptor},'$.version') IS 1 AND json_type(${t.descriptor},'$.checkpoint.version') IS 'integer' AND json_extract(${t.descriptor},'$.checkpoint.version') IS 1 AND json_type(${t.descriptor},'$.checkpoint.checkpoint.checkpoint.version') IS 'integer' AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.checkpoint.version') IS 1 AND json_type(${t.descriptor},'$.checkpoint.checkpoint.version') IS 'integer' AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.version') IS 1 AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.checkpoint.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.checkpoint.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.checkpoint.identity.epochId') IS ${t.epochId} AND json_extract(${t.descriptor},'$.checkpoint.checkpoint.checkpoint.identity.checkpointId') IS ${t.checkpointId}`,
    ),
    check(
      "local_recovery_retained_history_local_descriptor",
      sql`json_valid(${t.localDescriptor}) AND json_type(${t.localDescriptor},'$.version') IS 'integer' AND json_extract(${t.localDescriptor},'$.version') IS 1 AND json_extract(${t.localDescriptor},'$.identity.workspaceId') IS ${t.workspaceId} AND json_extract(${t.localDescriptor},'$.identity.deviceId') IS ${t.deviceId} AND json_extract(${t.localDescriptor},'$.identity.epochId') IS ${t.epochId} AND json_extract(${t.localDescriptor},'$.identity.checkpointId') IS ${t.checkpointId} AND json_extract(${t.localDescriptor},'$.identity.schemaId') IS json_extract(${t.descriptor},'$.checkpoint.checkpoint.checkpoint.identity.schemaId')`,
    ),
  ],
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
      // Deleting a taskspace preserves the card and clears its taskspace reference.
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    /**
     * The inventory the card is stored in, or null while it is on the canvas. Deleting an
     * inventory goes through `deleteInventory`, which clears both columns itself. The
     * `set null` here is the fallback for any other path, and a trigger from migration 0019
     * clears the slot with it.
     */
    inventoryId: text("inventory_id").references(() => inventoryTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    /**
     * Slot index within the inventory, counted left to right and top to bottom. Both inventory
     * fields are set or both are null. SQLite cannot add a CHECK to an existing table without
     * rebuilding it, so triggers from migration 0019 refuse a write that sets only one. Readers
     * still treat a card as stored only when both are set, for rows written before 0019.
     */
    inventorySlot: integer("inventory_slot"),
    content: text().notNull(),
    /**
     * Canvas position. A stored card keeps the position it had on the canvas, and returns
     * there when it leaves its inventory without being dropped somewhere else.
     */
    posX: integer("pos_x").notNull().default(0),
    posY: integer("pos_y").notNull().default(0),
    zIndex: integer("z_index").notNull().default(0),
    /** A null card width follows the configured default. */
    width: integer(),
    /**
     * Migration 0011 leaves `DEFAULT 0` on both database columns. Since migration 0019, a
     * trigger stamps raw SQL inserts that omit them with the insert time. Epoch timestamps from
     * before 0019 can remain, and `kozane doctor` reports them.
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
    // Support the lookup by layer when `deleteLayerWithReassign` moves cards off a deleted layer.
    index("card_layer").on(t.layerId),
    // Cover the partition and update-time columns read by `getCardChangeCounts` for map
    // activity bands. Keep the narrower partition index for frequent board reads.
    index("card_partition_updated").on(t.partitionId, t.updatedAt),
    // One card per slot. SQLite treats NULLs as distinct, so cards on the canvas never
    // collide. Leading with `inventory_id` also serves reads of one inventory's cards.
    uniqueIndex("card_inventory_slot").on(t.inventoryId, t.inventorySlot),
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

// Relations enable the relational query API, such as
// `db.query.namespaceTable.findMany({ with: { partitions: true } })`.

export const namespaceRelations = relations(namespaceTable, ({ many }) => ({
  partitions: many(partitionTable),
  layers: many(layerTable),
  warps: many(warpTable),
  inventories: many(inventoryTable),
  scopeAreas: many(scopeAreaTable),
}));

export const inventoryRelations = relations(inventoryTable, ({ one, many }) => ({
  namespace: one(namespaceTable, {
    fields: [inventoryTable.namespaceId],
    references: [namespaceTable.id],
  }),
  cards: many(cardTable),
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
  inventory: one(inventoryTable, {
    fields: [cardTable.inventoryId],
    references: [inventoryTable.id],
  }),
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
