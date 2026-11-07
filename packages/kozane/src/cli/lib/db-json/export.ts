/** Writing a workspace database out as a JSON dump. */
import { createClient } from "@libsql/client";
import { EXPORT_KIND, EXPORT_VERSION, TABLES, type DbJsonDump } from "./format.js";
import { selectSql, countSql, emptyTables, rowToJson } from "./sql.js";

export async function exportDbJson(
  dbUrl: string,
  migrations: DbJsonDump["migrations"] = { applied: null, latest: null },
): Promise<DbJsonDump> {
  const client = createClient({ url: dbUrl });
  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    const tables = emptyTables();
    for (const table of TABLES) {
      let rows;
      try {
        rows = (await client.execute(selectSql(table))).rows;
      } catch (e) {
        // Add the table name when a read fails, including when the client rejects an unsafe
        // integer. Preserve the original error as `cause` for diagnostics.
        throw new Error(
          `Failed to read table ${table.name} for export: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
      tables[table.name] = rows.map((row) => rowToJson(row, table.name));
    }

    return {
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      migrations,
      tables,
    };
  } finally {
    client.close();
  }
}

export async function hasDbJsonRows(dbUrl: string): Promise<boolean> {
  const client = createClient({ url: dbUrl });
  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    for (const table of TABLES) {
      const result = await client.execute(countSql(table));
      const rawCount = result.rows[0]?.count;
      const count =
        typeof rawCount === "number"
          ? rawCount
          : typeof rawCount === "bigint"
            ? Number(rawCount)
            : Number(rawCount ?? 0);
      if (count > 0) return true;
    }
    return false;
  } finally {
    client.close();
  }
}

export function stringifyDbJson(dump: DbJsonDump, pretty = true): string {
  return `${JSON.stringify(dump, null, pretty ? 2 : 0)}\n`;
}
