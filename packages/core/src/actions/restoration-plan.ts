import type { SchemaManifest } from "../schema-types.js";
import type { ProjectionTable } from "./projection.js";

export class RestorationSchemaError extends Error {
  override readonly name = "RestorationSchemaError";
}

/** Plan a complete row replacement before touching a destination database. */
export function createRestorationPlan(manifest: SchemaManifest, dataTables: readonly string[]) {
  const objects = manifest.filter((object) => object.type === "table");
  const tables = new Map(objects.map((object) => [object.name, object]));
  const selected = new Set(dataTables);
  function fail(message: string): never {
    throw new RestorationSchemaError(message);
  }
  if (tables.size !== objects.length || selected.size !== dataTables.length || !selected.size)
    fail("Restoration requires distinct schema tables and a nonempty table selection");
  const definitions = new Map<string, ProjectionTable>();
  for (const name of selected) {
    const object = tables.get(name);
    if (!object?.columns?.length || !object.foreignKeys)
      fail(`Missing restoration table metadata: ${name}`);
    const columns: string[] = [];
    const keys: { name: string; ordinal: number }[] = [];
    for (const column of object.columns) {
      const [cid, columnName, , , , pk, hidden] = column;
      if (
        !Number.isSafeInteger(cid) ||
        typeof columnName !== "string" ||
        !columnName.length ||
        !Number.isSafeInteger(pk) ||
        Number(pk) < 0 ||
        hidden !== 0
      )
        fail(`Unsupported restoration column: ${name}`);
      columns.push(columnName);
      if (Number(pk) > 0) keys.push({ name: columnName, ordinal: Number(pk) });
    }
    keys.sort((a, b) => a.ordinal - b.ordinal);
    if (
      new Set(columns).size !== columns.length ||
      !keys.length ||
      keys.some((key, index) => key.ordinal !== index + 1)
    )
      fail(`Invalid restoration columns or primary key: ${name}`);
    definitions.set(
      name,
      Object.freeze({
        name,
        columns: Object.freeze(columns),
        primaryKey: Object.freeze(keys.map(({ name }) => name)),
      }),
    );
  }
  const dependencies = new Map([...selected].map((name) => [name, new Set<string>()]));
  for (const object of objects) {
    if (!object.foreignKeys) fail(`Missing foreign-key metadata: ${object.name}`);
    for (const key of object.foreignKeys) {
      const parent = key[2];
      if (typeof parent !== "string" || !tables.has(parent))
        fail(`Unknown foreign-key parent: ${object.name}`);
      if (!selected.has(object.name)) {
        if (selected.has(parent)) fail(`Excluded table references restored rows: ${object.name}`);
        continue;
      }
      if (!selected.has(parent))
        fail(`Restoration omits foreign-key parent: ${object.name} -> ${parent}`);
      const from = key[3];
      const to = key[4];
      if (
        typeof from !== "string" ||
        !definitions.get(object.name)!.columns.includes(from) ||
        (to !== null && (typeof to !== "string" || !definitions.get(parent)!.columns.includes(to)))
      )
        fail(`Invalid restoration foreign-key columns: ${object.name}`);
      dependencies.get(object.name)!.add(parent);
    }
  }
  const loadOrder: ProjectionTable[] = [];
  const remaining = new Map(dependencies);
  while (remaining.size) {
    const ready = [...remaining]
      .filter(([, parents]) => !parents.size)
      .map(([name]) => name)
      .sort();
    if (!ready.length) fail("Restoration requires an acyclic foreign-key graph");
    for (const name of ready) {
      loadOrder.push(definitions.get(name)!);
      remaining.delete(name);
      for (const parents of remaining.values()) parents.delete(name);
    }
  }
  return Object.freeze({
    loadOrder: Object.freeze(loadOrder),
    deleteOrder: Object.freeze(loadOrder.map(({ name }) => name).reverse()),
  });
}
