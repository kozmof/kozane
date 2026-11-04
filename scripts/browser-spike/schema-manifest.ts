export type SchemaQuery = (sql: string) => Promise<unknown[][]>;

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
      /^(?:'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\p{L}\p{N}_$]+|->>|->|\|\||<=|>=|<>|!=|==|.)/u.exec(
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

/** Read-only prototype. SQL definitions retain constraints, expressions, triggers and views. */
export async function schemaManifest(query: SchemaQuery) {
  const objects = await query(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
  );
  const manifest = [];
  for (const [type, rawName, table, definition] of objects) {
    const name = String(rawName);
    const entry: Record<string, unknown> = {
      type,
      name,
      table,
      sql: definition === null ? null : normalizeSchemaSql(String(definition)),
    };
    if (type === "table") {
      entry.columns = await query(`PRAGMA table_xinfo(${quote(name)})`);
      entry.foreignKeys = (await query(`PRAGMA foreign_key_list(${quote(name)})`)).sort(
        (a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]),
      );
      // Index names are SQLite-owned for implicit constraints. Compare their shape instead.
      const indexes = await query(`PRAGMA index_list(${quote(name)})`);
      entry.indexes = (
        await Promise.all(
          indexes.map(async (index) => ({
            unique: index[2],
            origin: index[3],
            partial: index[4],
            columns: await query(`PRAGMA index_xinfo(${quote(String(index[1]))})`),
          })),
        )
      ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    manifest.push(entry);
  }
  return manifest;
}
