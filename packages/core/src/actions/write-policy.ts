import { getTableColumns, is, SQL } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

export class ActionWriteError extends Error {
  override readonly name = "ActionWriteError";
  readonly code = "action-write-invalid";
}

function copyFields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ActionWriteError("Action writes require explicit row objects");
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new ActionWriteError("Action writes require plain row objects");
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor))
      throw new ActionWriteError("Action write fields cannot use accessors");
    const value: unknown = descriptor.value;
    // Query construction must snapshot Dates before the caller can mutate them.
    output[key] = value instanceof Date ? new Date(Date.prototype.getTime.call(value)) : value;
  }
  return output;
}

/** ORM checks supplement the persistent SQL guards required before activation. */
export function actionWritePolicy(input: unknown) {
  if (!is(input, SQLiteTable)) throw new ActionWriteError("Action writes require a SQLite table");
  const table = input;
  const config = getTableConfig(table);
  const columns = Object.entries(getTableColumns(table));
  const primary = new Set([
    ...config.columns.filter((column) => column.primary).map((column) => column.name),
    ...config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
  ]);
  const keys = columns.filter(([, column]) => primary.has(column.name)).map(([key]) => key);
  const insertDefaults = columns.filter(
    ([, column]) => column.defaultFn || column.onUpdateFn || primary.has(column.name),
  );
  const updateDefaults = columns.filter(([, column]) => column.onUpdateFn);

  function explicitDefaults(fields: Record<string, unknown>, defaults: typeof columns) {
    for (const [key, column] of defaults) {
      const value = fields[key];
      if (
        value === undefined ||
        (value === null && (column.notNull || primary.has(column.name))) ||
        is(value, SQL)
      )
        throw new ActionWriteError(
          `Action write requires an explicit value for ${config.name}.${key}`,
        );
      if (value !== null && column.dataType === "date") {
        if (!(value instanceof Date))
          throw new ActionWriteError(`Action timestamp requires a Date for ${config.name}.${key}`);
        const milliseconds = Date.prototype.getTime.call(value);
        if (
          !Number.isFinite(milliseconds) ||
          (config.name === "card" && Math.floor(milliseconds / 1000) === 0)
        )
          throw new ActionWriteError(`Action timestamp is invalid for ${config.name}.${key}`);
      }
    }
  }
  return Object.freeze({
    insert(input: unknown): unknown {
      const rows = Array.isArray(input) ? input : [input];
      if (!rows.length) throw new ActionWriteError("Action inserts require at least one row");
      const prepared = rows.map((row) => {
        const fields = copyFields(row);
        explicitDefaults(fields, insertDefaults);
        return fields;
      });
      return Array.isArray(input) ? prepared : prepared[0];
    },
    update(input: unknown): Record<string, unknown> {
      const fields = copyFields(input);
      if (keys.some((key) => fields[key] !== undefined))
        throw new ActionWriteError(`Action updates cannot assign primary keys in ${config.name}`);
      // This Drizzle version calls update generators even for explicitly supplied values.
      if (updateDefaults.length)
        throw new ActionWriteError(
          `Action updates cannot use ORM update generators in ${config.name}`,
        );
      return fields;
    },
  });
}
