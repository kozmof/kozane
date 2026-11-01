/** Replacing a workspace database's rows with a JSON dump. */
import { createClient, type InValue } from "@libsql/client";
import { chunked } from "../../../lib/constants.js";
import { applyConnectionPragmas, BUSY_TIMEOUT_MS } from "../../../db/pragmas.js";
import { TABLES, type TableName } from "./format.js";
import { insertSql, deleteSql } from "./sql.js";
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
  const client = createClient({ url: dbUrl, timeout: BUSY_TIMEOUT_MS });

  try {
    await applyConnectionPragmas(client, dbUrl);
    await client.execute("BEGIN");
    try {
      for (const table of [...TABLES].reverse()) {
        await client.execute(deleteSql(table));
      }

      for (const table of TABLES) {
        for (const batch of chunked(dump.tables[table.name], {
          columnsPerRow: table.columns.length,
        })) {
          await client.execute({
            sql: insertSql(table, batch.length),
            args: batch.flatMap((row) => table.columns.map((column) => row[column] as InValue)),
          });
        }
      }

      await client.execute("COMMIT");
    } catch (e) {
      // Report the failure that stopped the import, not a rollback failing after it.
      try {
        await client.execute("ROLLBACK");
      } catch {
        // SQLite may already have rolled back, for example after SQLITE_FULL.
      }
      throw e;
    }

    return Object.fromEntries(
      TABLES.map((table) => [table.name, dump.tables[table.name].length]),
    ) as Record<TableName, number>;
  } finally {
    client.close();
  }
}
