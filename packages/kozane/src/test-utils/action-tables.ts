/** Application row metadata and codec reads shared by test-only action fixtures. */
import { is, sql } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../../core/src/schema.js";
import { localTableNames } from "../../../core/src/actions/local-tables.js";
import type { DB, Tx } from "../../../core/src/database.js";
import type { ProjectionRow } from "../../../core/src/actions/projection.js";
import { captureRowSql, decodeCapturedRow } from "../../../core/src/actions/sql-codec.js";
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export const capturedTables = Object.freeze(
  Object.values(schema)
    .filter((table) => is(table, SQLiteTable))
    .filter((table) => !localTableNames.includes(getTableConfig(table).name))
    .map((table) => {
      const config = getTableConfig(table);
      const primaryKey = [
        ...new Set([
          ...config.columns.filter((column) => column.primary).map((column) => column.name),
          ...config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
        ]),
      ];
      if (!primaryKey.length)
        throw new Error(`Capture fixture requires a primary key: ${config.name}`);
      return Object.freeze({
        name: config.name,
        columns: Object.freeze(config.columns.map((column) => column.name)),
        primaryKey: Object.freeze(primaryKey),
      });
    })
    .sort((a, b) => a.name.localeCompare(b.name)),
);

type Handle = DB | Tx;
export async function captureApplicationRows(db: Handle): Promise<ProjectionRow[]> {
  const output: ProjectionRow[] = [];
  for (const table of capturedTables) {
    const rows = await db.values(
      sql.raw(
        `SELECT ${captureRowSql(table.columns)} FROM ${quote(table.name)} ORDER BY ${table.primaryKey.map(quote).join(",")}`,
      ),
    );
    for (const row of rows) {
      if (typeof row[0] !== "string") throw new Error("Capture did not return a JSON image");
      output.push({ table: table.name, row: decodeCapturedRow(row[0]) });
    }
  }
  return output;
}
