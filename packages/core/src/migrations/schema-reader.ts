import type {
  SchemaQuery,
  SchemaManifest,
  SchemaObject,
  SchemaRow,
  SchemaValue,
} from "../schema-types.js";

/** Freeze the generated manifest and comparison results recursively. */
export function freezeSchema<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeSchema(child);
    Object.freeze(value);
  }
  return value;
}
function row(values: readonly unknown[]): SchemaRow {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    throw new Error("Invalid schema introspection value");
  });
}

/** Ignore whitespace/comments outside quoted tokens. Preserve identifier and literal spelling. */
export function normalizeSchemaSql(sql: string): string[] {
  const tokens: string[] = [];
  let rest = sql;
  while (rest.length) {
    const ignored = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (ignored) {
      rest = rest.slice(ignored[0].length);
      continue;
    }
    const token =
      /^(?:'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[\p{L}\p{N}_$]+|->>|->|\|\||<=|>=|<>|!=|==|.)/u.exec(
        rest,
      );
    if (!token) throw new Error("Unsupported schema SQL");
    tokens.push(token[0]);
    rest = rest.slice(token[0].length);
  }
  while (tokens.at(-1) === ";") tokens.pop();
  return tokens;
}

function quote(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

/** Read all application schema objects, excluding SQLite-owned objects and statistics. */
export async function readSchemaManifest(query: SchemaQuery): Promise<SchemaManifest> {
  const objects = await query(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
  );
  const manifest: SchemaObject[] = [];
  for (const [type, rawName, table, definition] of objects) {
    const name = String(rawName);
    if (
      typeof type !== "string" ||
      typeof rawName !== "string" ||
      typeof table !== "string" ||
      (definition !== null && typeof definition !== "string")
    )
      throw new Error("Invalid schema introspection object");
    const entry: {
      type: string;
      name: string;
      table: string;
      sql: readonly string[] | null;
      columns?: readonly (readonly (SchemaValue | readonly string[])[])[];
      foreignKeys?: readonly SchemaRow[];
      indexes?: SchemaObject["indexes"];
    } = {
      type,
      name,
      table,
      sql: definition === null ? null : normalizeSchemaSql(String(definition)),
    };
    if (type === "table") {
      entry.columns = (await query(`PRAGMA table_xinfo(${quote(name)})`)).map((values) =>
        row(values).map((value, index) =>
          (index === 2 || index === 4) && typeof value === "string"
            ? normalizeSchemaSql(value)
            : value,
        ),
      );
      entry.foreignKeys = (await query(`PRAGMA foreign_key_list(${quote(name)})`))
        .map(row)
        .sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
      // Index names are SQLite-owned for implicit constraints. Compare their shape instead.
      const indexes = await query(`PRAGMA index_list(${quote(name)})`);
      entry.indexes = (
        await Promise.all(
          indexes.map(async (index) => ({
            unique: row(index)[2],
            origin: row(index)[3],
            partial: row(index)[4],
            columns: (await query(`PRAGMA index_xinfo(${quote(String(index[1]))})`)).map(row),
          })),
        )
      ).sort((a, b) =>
        JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0,
      );
    }
    manifest.push(entry);
  }
  return freezeSchema(manifest);
}
