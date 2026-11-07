/** Checks that a dump's references and taskspace paths are safe to import. */
import { INVENTORY_SLOT_MAX } from "../../../lib/constants.js";
import { plural } from "../plural.js";
import { taskspacePathIssue } from "../../../lib/server/taskspace-path.js";
import { type TableRows } from "./format.js";
import { type ImportDbJsonOptions } from "./import.js";

/**
 * Validate every foreign key before inserting rows. SQLite also enforces these constraints
 * during import, but this check identifies the offending row.
 */
export function validateDumpRefs(tables: TableRows): void {
  const namespaceIds = new Set(tables.namespace.map((r) => r.id as string));
  const partitionIds = new Set(tables.partition.map((r) => r.id as string));
  const layerIds = new Set(tables.layer.map((r) => r.id as string));
  const cardIds = new Set(tables.card.map((r) => r.id as string));
  const glueIds = new Set(tables.glue.map((r) => r.id as string));
  const scopeIds = new Set(tables.scope.map((r) => r.id as string));
  const taskspaceIds = new Set(tables.taskspace.map((r) => r.id as string));
  const inventoryNamespace = new Map(
    tables.inventory.map((r) => [r.id as string, r.namespace_id as string]),
  );
  const partitionNamespace = new Map(
    tables.partition.map((r) => [r.id as string, r.namespace_id as string]),
  );
  /** Each stored card's inventory and slot, so two cards in one slot are caught here. */
  const storedSlots = new Set<string>();

  if (tables.namespace.filter((row) => Number(row.is_default) === 1).length > 1)
    throw new Error("namespace: more than one namespace is marked as the default");
  for (const row of tables.partition) {
    if (!namespaceIds.has(row.namespace_id as string))
      throw new Error(`partition ${row.id}: references unknown namespace_id ${row.namespace_id}`);
  }
  for (const row of tables.layer) {
    if (!namespaceIds.has(row.namespace_id as string))
      throw new Error(`layer ${row.id}: references unknown namespace_id ${row.namespace_id}`);
  }
  for (const row of tables.warp) {
    if (!namespaceIds.has(row.namespace_id as string))
      throw new Error(`warp ${row.id}: references unknown namespace_id ${row.namespace_id}`);
  }
  for (const row of tables.inventory) {
    if (!namespaceIds.has(row.namespace_id as string))
      throw new Error(`inventory ${row.id}: references unknown namespace_id ${row.namespace_id}`);
  }
  for (const row of tables.card) {
    if (!partitionIds.has(row.partition_id as string))
      throw new Error(`card ${row.id}: references unknown partition_id ${row.partition_id}`);
    // `card.layer_id` is NOT NULL, so a null arriving here is caught by the same check
    // and reported as the unknown reference it is rather than as a constraint failure.
    if (!layerIds.has(row.layer_id as string))
      throw new Error(`card ${row.id}: references unknown layer_id ${row.layer_id}`);
    if (row.taskspace_id !== null && !taskspaceIds.has(row.taskspace_id as string))
      throw new Error(`card ${row.id}: references unknown taskspace_id ${row.taskspace_id}`);
    if ((row.inventory_id === null) !== (row.inventory_slot === null))
      throw new Error(`card ${row.id}: inventory_id and inventory_slot must be set together`);
    if (row.inventory_id !== null) {
      const namespaceId = inventoryNamespace.get(row.inventory_id as string);
      if (namespaceId === undefined)
        throw new Error(`card ${row.id}: references unknown inventory_id ${row.inventory_id}`);
      // A card stored in another namespace's inventory would show on neither board.
      if (namespaceId !== partitionNamespace.get(row.partition_id as string))
        throw new Error(
          `card ${row.id}: inventory_id ${row.inventory_id} belongs to another namespace`,
        );
      const slot = row.inventory_slot;
      if (
        typeof slot !== "number" ||
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot > INVENTORY_SLOT_MAX
      )
        throw new Error(
          `card ${row.id}: inventory_slot must be an integer from 0 to ${INVENTORY_SLOT_MAX}`,
        );
      const key = `${row.inventory_id as string}\0${slot}`;
      if (storedSlots.has(key))
        throw new Error(`card ${row.id}: inventory ${row.inventory_id} slot ${slot} is taken`);
      storedSlots.add(key);
    }
  }
  for (const row of tables.taskspace) {
    if (row.namespace_id !== null && !namespaceIds.has(row.namespace_id as string))
      throw new Error(`taskspace ${row.id}: references unknown namespace_id ${row.namespace_id}`);
    if (row.scope_id !== null && !scopeIds.has(row.scope_id as string))
      throw new Error(`taskspace ${row.id}: references unknown scope_id ${row.scope_id}`);
  }
  for (const row of tables.glue_rel) {
    if (!glueIds.has(row.glue_id as string))
      throw new Error(`glue_rel: references unknown glue_id ${row.glue_id}`);
    if (!cardIds.has(row.card_id as string))
      throw new Error(`glue_rel: references unknown card_id ${row.card_id}`);
  }
  for (const row of tables.scope_rel) {
    if (!scopeIds.has(row.scope_id as string))
      throw new Error(`scope_rel: references unknown scope_id ${row.scope_id}`);
    if (!cardIds.has(row.card_id as string))
      throw new Error(`scope_rel: references unknown card_id ${row.card_id}`);
  }
  for (const row of tables.scope_area) {
    if (!scopeIds.has(row.scope_id as string))
      throw new Error(`scope_area ${row.id}: references unknown scope_id ${row.scope_id}`);
    if (!namespaceIds.has(row.namespace_id as string))
      throw new Error(`scope_area ${row.id}: references unknown namespace_id ${row.namespace_id}`);
  }
  // Every namespace needs exactly one default partition and one default layer. Cards created
  // without a partition or layer go there, and deleting a partition or layer moves its cards
  // there. Checked last so a dangling reference above is reported first.
  for (const [label, rows] of [
    ["partition", tables.partition],
    ["layer", tables.layer],
  ] as const) {
    const defaults = new Map<string, number>();
    for (const row of rows)
      if (Number(row.is_default) === 1) {
        const namespaceId = row.namespace_id as string;
        defaults.set(namespaceId, (defaults.get(namespaceId) ?? 0) + 1);
      }
    for (const { id } of tables.namespace) {
      const found = defaults.get(id as string) ?? 0;
      if (found !== 1)
        throw new Error(`namespace ${id}: must have exactly one default ${label}, found ${found}`);
    }
  }
}

/**
 * Refuse taskspace paths that could reach outside the workspace before writing any row.
 * Absolute paths are refused unless the caller opts in.
 */
export function validateDumpPaths(
  tables: TableRows,
  { allowAbsolutePaths = false }: ImportDbJsonOptions,
) {
  const absolute: string[] = [];
  for (const row of tables.taskspace) {
    if (row.path === null || row.path === undefined) continue;
    if (typeof row.path !== "string")
      throw new Error(`taskspace ${row.id}: path must be a string or null`);
    const issue = taskspacePathIssue(row.path, String(row.path_kind));
    if (issue) throw new Error(`taskspace ${row.id}: ${issue}`);
    if (row.path_kind === "absolute") absolute.push(`${row.id} (${row.path})`);
  }
  if (absolute.length > 0 && !allowAbsolutePaths)
    throw new Error(
      `Export has ${plural(absolute.length, "taskspace")} with an absolute path outside the workspace: ${absolute.join(", ")}. ` +
        "Kozane serves files from these directories. Rerun with --allow-absolute-paths if you trust them.",
    );
}
