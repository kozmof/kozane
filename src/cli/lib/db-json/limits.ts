/** Warnings for dumped rows over the workspace's configured limits. */
import { NAME_MAX } from "../../../lib/constants.js";
import { plural } from "../plural.js";
import { type TableName, type JsonObject } from "./format.js";

/**
 * Workspace limits used to check imported rows. Use the target workspace's configured limits,
 * which may differ from the source's.
 */
export type DumpLimits = { contentMax: number; canvasWidth: number; canvasHeight: number };

/** Limit warning samples as doctor does to keep output bounded. */
const LIMIT_WARNING_NAMED_MAX = 5;

/** Sample IDs and the count of remaining matches. */
function nameSome(ids: string[]): string {
  const named = ids.slice(0, LIMIT_WARNING_NAMED_MAX);
  const rest = ids.length - named.length;
  return rest > 0 ? `${named.join(", ")}, and ${rest} more` : named.join(", ");
}

function overLimit(
  rows: JsonObject[],
  offending: (row: JsonObject) => boolean,
): { total: number; ids: string[] } {
  const hit = rows.filter(offending);
  return { total: hit.length, ids: hit.map((row) => String(row.id)) };
}

/**
 * Read a table's rows for the post-import warning report. Return no rows for an unexpected
 * shape so reporting cannot turn a successful restore into an apparent failure. `parseDump`
 * already validated the import.
 */
function rowsOf(input: unknown, table: TableName): JsonObject[] {
  if (typeof input !== "object" || input === null) return [];
  const tables = (input as { tables?: unknown }).tables;
  if (typeof tables !== "object" || tables === null) return [];
  const rows = (tables as Record<string, unknown>)[table];
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is JsonObject => typeof row === "object" && row !== null && !Array.isArray(row),
  );
}

/**
 * Report imported rows that exceed the target workspace's text, name, or canvas limits.
 *
 * These configurable limits do not invalidate a backup. Warn after a successful import so
 * workspaces with different settings can exchange dumps. Broken foreign keys are rejected
 * separately by {@link validateDumpRefs}.
 *
 * Return one line per condition. `kozane doctor` can find the same conditions in the restored
 * database later.
 */
export function dumpLimitWarnings(input: unknown, limits: DumpLimits): string[] {
  const warnings: string[] = [];
  const { contentMax, canvasWidth, canvasHeight } = limits;
  const cards = rowsOf(input, "card");

  const long = overLimit(
    cards,
    (row) => typeof row.content === "string" && row.content.length > contentMax,
  );
  if (long.total > 0)
    warnings.push(
      `card: ${plural(long.total, "card")} longer than this workspace's ` +
        `ui.contentMax of ${contentMax} characters (${nameSome(long.ids)}). ` +
        `Editing one through the board or 'kozane card edit' will refuse it until it is shortened.`,
    );

  // Check positions against the configured canvas size.
  const offBoard = overLimit(
    cards,
    (row) =>
      Number(row.pos_x) < 0 ||
      Number(row.pos_y) < 0 ||
      Number(row.pos_x) > canvasWidth ||
      Number(row.pos_y) > canvasHeight,
  );
  if (offBoard.total > 0)
    warnings.push(
      `card: ${plural(offBoard.total, "card")} positioned outside this ` +
        `workspace's ${canvasWidth}×${canvasHeight} canvas ` +
        `(${nameSome(offBoard.ids)}). Use 'kozane card move' to bring one back, ` +
        `or raise ui.canvasWidth / ui.canvasHeight.`,
    );

  // Combine named entities into one warning. Include the table with each ID to distinguish
  // rows across tables.
  const namedTables: TableName[] = ["namespace", "partition", "layer", "scope", "taskspace"];
  const longNames = namedTables.flatMap((table) =>
    rowsOf(input, table)
      .filter((row) => typeof row.name === "string" && row.name.length > NAME_MAX)
      .map((row) => `${table} ${String(row.id)}`),
  );
  if (longNames.length > 0)
    warnings.push(
      `${plural(longNames.length, "name")} longer than the ${NAME_MAX}-character ` +
        `limit (${nameSome(longNames)}). Renaming one will refuse it until it is shortened.`,
    );

  return warnings;
}
