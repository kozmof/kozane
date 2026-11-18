import { parseTaggedRow, taggedRowKey, taggedRowsEqual, type TaggedRow } from "./row-codec.js";

export interface ProjectionTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
}
export interface ProjectionEffect {
  readonly ord: number;
  readonly table: string;
  readonly key: TaggedRow;
  readonly op: "I" | "U" | "D";
  readonly before: TaggedRow | null;
  readonly after: TaggedRow | null;
}
export interface ProjectionRow {
  readonly table: string;
  readonly row: TaggedRow;
}
export class ProjectionError extends Error {
  override readonly name = "ProjectionError";
}

/** Intermediate images have no constraints, triggers or cascades. Each apply returns a new projection. */
export function createRowProjection(
  schema: readonly ProjectionTable[],
  baseline: readonly ProjectionRow[],
) {
  const tables = new Map(
    schema.map((table) => [
      table.name,
      Object.freeze({
        name: table.name,
        columns: [...table.columns],
        primaryKey: [...table.primaryKey],
      }),
    ]),
  );
  if (tables.size !== schema.length) throw new ProjectionError("Duplicate projection table");
  for (const table of tables.values()) {
    if (
      !table.columns.length ||
      !table.primaryKey.length ||
      new Set(table.columns).size !== table.columns.length ||
      new Set(table.primaryKey).size !== table.primaryKey.length ||
      table.primaryKey.some((column) => !table.columns.includes(column))
    )
      throw new ProjectionError(`Invalid projection schema: ${table.name}`);
  }
  function table(name: string) {
    const definition = tables.get(name);
    if (!definition) throw new ProjectionError(`Unknown projection table: ${name}`);
    return definition;
  }
  function row(name: string, image: unknown): TaggedRow {
    const definition = table(name);
    const parsed = parseTaggedRow(image);
    if (
      Object.keys(parsed).length !== definition.columns.length ||
      definition.columns.some((column) => !Object.hasOwn(parsed, column))
    )
      throw new ProjectionError(`Incomplete row image: ${name}`);
    return parsed;
  }
  function key(name: string, image: TaggedRow): TaggedRow {
    return parseTaggedRow(
      Object.fromEntries(table(name).primaryKey.map((column) => [column, image[column]])),
    );
  }
  const rows = new Map<string, Map<string, TaggedRow>>(
    [...tables.keys()].map((name) => [name, new Map()]),
  );
  for (const entry of baseline) {
    const parsed = row(entry.table, entry.row);
    const identity = taggedRowKey(key(entry.table, parsed));
    const contents = rows.get(entry.table)!;
    if (contents.has(identity))
      throw new ProjectionError(`Duplicate baseline key: ${entry.table} ${identity}`);
    contents.set(identity, parsed);
  }
  function projection(state: typeof rows) {
    return Object.freeze({
      rows(name: string): readonly TaggedRow[] {
        table(name);
        return Object.freeze([...state.get(name)!.values()]);
      },
      verifyInstalledRows(name: string, installed: readonly TaggedRow[]): void {
        table(name);
        const expected = state.get(name)!;
        const actual = new Map<string, TaggedRow>();
        for (const image of installed) {
          const parsed = row(name, image);
          const identity = taggedRowKey(key(name, parsed));
          if (actual.has(identity))
            throw new ProjectionError(`Duplicate installed key: ${name} ${identity}`);
          actual.set(identity, parsed);
        }
        if (expected.size !== actual.size)
          throw new ProjectionError(`Installed row count mismatch: ${name}`);
        for (const [identity, image] of expected) {
          const loaded = actual.get(identity);
          if (!loaded || !taggedRowsEqual(image, loaded))
            throw new ProjectionError(`Installed row differs from projection: ${name} ${identity}`);
        }
      },
      apply(effects: readonly ProjectionEffect[]) {
        const next = new Map([...state].map(([name, contents]) => [name, new Map(contents)]));
        let previous = -1;
        for (const effect of effects) {
          if (!Number.isSafeInteger(effect.ord) || effect.ord < 0 || effect.ord <= previous)
            throw new ProjectionError("Effects must have strictly increasing nonnegative ordinals");
          previous = effect.ord;
          const definition = table(effect.table);
          const identity = parseTaggedRow(effect.key);
          if (
            Object.keys(identity).length !== definition.primaryKey.length ||
            definition.primaryKey.some((column) => !Object.hasOwn(identity, column))
          )
            throw new ProjectionError(`Incomplete effect key: ${effect.table}`);
          const encodedKey = taggedRowKey(identity);
          const contents = next.get(effect.table)!;
          const current = contents.get(encodedKey);
          const before = effect.before === null ? null : row(effect.table, effect.before);
          const after = effect.after === null ? null : row(effect.table, effect.after);
          for (const image of [before, after]) {
            if (image && !taggedRowsEqual(key(effect.table, image), identity))
              throw new ProjectionError(
                `Effect changes or mismatches primary key: ${effect.table} ${encodedKey}`,
              );
          }
          if (effect.op === "I") {
            if (before !== null || after === null || current)
              throw new ProjectionError(`Invalid insert effect: ${effect.table} ${encodedKey}`);
            contents.set(encodedKey, after);
          } else if (effect.op === "U" || effect.op === "D") {
            if (before === null || !current || !taggedRowsEqual(current, before))
              throw new ProjectionError(`Before image mismatch: ${effect.table} ${encodedKey}`);
            if (effect.op === "D") {
              if (after !== null) throw new ProjectionError("Delete effect has an after image");
              contents.delete(encodedKey);
            } else {
              if (after === null) throw new ProjectionError("Update effect has no after image");
              contents.set(encodedKey, after);
            }
          } else throw new ProjectionError(`Unknown effect operation: ${effect.op}`);
        }
        return projection(next);
      },
    });
  }
  return projection(rows);
}
