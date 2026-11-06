/** SQL statements for reading and writing dump tables, and row conversion. */
import { TABLES, type TableName, type TableRows, type JsonObject } from "./format.js";

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function selectSql(table: (typeof TABLES)[number]): string {
  const columns = table.columns.map(quoteIdent).join(", ");
  const orderBy = table.orderBy.map(quoteIdent).join(", ");
  return `SELECT ${columns} FROM ${quoteIdent(table.name)} ORDER BY ${orderBy}`;
}

export function deleteSql(table: (typeof TABLES)[number]): string {
  return `DELETE FROM ${quoteIdent(table.name)}`;
}

export function countSql(table: (typeof TABLES)[number]): string {
  return `SELECT COUNT(*) AS count FROM ${quoteIdent(table.name)}`;
}

export function emptyTables(): TableRows {
  return Object.fromEntries(TABLES.map((table) => [table.name, []])) as unknown as TableRows;
}

/** Report the table and column when a value cannot be represented in JSON. */
export function rowToJson(row: Record<string, unknown>, table: TableName): JsonObject {
  const next: JsonObject = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      next[key] = value;
      continue;
    }

    // The default client rejects oversized integers during `SELECT`, before they reach this
    // branch. Support clients configured to return bigints by converting values that fit
    // safely in a number.
    if (typeof value === "bigint") {
      const asNumber = Number(value);
      if (!Number.isSafeInteger(asNumber))
        throw new Error(`Value for ${table}.${key} exceeds JSON range`);
      next[key] = asNumber;
      continue;
    }

    // A BLOB arrives as an `ArrayBuffer`. The schema has no BLOB columns, so this value is
    // invalid for an export.
    throw new Error(`Unsupported database value for ${table}.${key}`);
  }
  return next;
}
