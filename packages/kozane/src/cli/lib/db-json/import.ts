/** Replacing a workspace database's rows with a JSON dump. */
import { sql } from "drizzle-orm";
import { openDb } from "../../../db/client.js";
import { withTx } from "../../../db/database.js";
import { chunked } from "../../../lib/constants.js";
import { TABLES, type TableName } from "./format.js";
import { deleteSql } from "./sql.js";
import { parseDump } from "./parse.js";
import { validateDumpRefs, validateDumpPaths } from "./validate.js";

export type ImportDbJsonOptions = {
  /**
   * Accept taskspaces stored with absolute paths. The server reads and writes files in a
   * taskspace's directory, so an export from elsewhere could otherwise expose any directory
   * on this machine to the board.
   */
  allowAbsolutePaths?: boolean;
};

export async function importDbJson(
  dbUrl: string,
  input: unknown,
  options: ImportDbJsonOptions = {},
): Promise<Record<TableName, number>> {
  const dump = parseDump(input);
  validateDumpRefs(dump.tables);
  validateDumpPaths(dump.tables, options);
  const { db, close } = await openDb(dbUrl);

  try {
    await withTx(db, async (tx) => {
      for (const table of [...TABLES].reverse()) await tx.run(sql.raw(deleteSql(table)));
      for (const table of TABLES) {
        for (const batch of chunked(dump.tables[table.name], {
          columnsPerRow: table.columns.length,
        })) {
          const columns = sql.join(
            table.columns.map((column) => sql.identifier(column)),
            sql`, `,
          );
          const rows = batch.map(
            (row) =>
              sql`(${sql.join(
                table.columns.map((column) => sql`${row[column]}`),
                sql`, `,
              )})`,
          );
          await tx.run(
            sql`INSERT INTO ${sql.identifier(table.name)} (${columns}) VALUES ${sql.join(rows, sql`, `)}`,
          );
        }
      }
    });

    return Object.fromEntries(
      TABLES.map((table) => [table.name, dump.tables[table.name].length]),
    ) as Record<TableName, number>;
  } finally {
    close();
  }
}
