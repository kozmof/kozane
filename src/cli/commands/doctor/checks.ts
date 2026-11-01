/** The database checks `kozane doctor` runs. */
import { createConnection } from "node:net";
import { createClient } from "@libsql/client";
import { count, gt, lt, or, sql, type SQL } from "drizzle-orm";
import { openDb } from "../../../db/client.js";
import { BUSY_TIMEOUT_MS } from "../../../db/pragmas.js";
import {
  cardTable,
  layerTable,
  namespaceTable,
  partitionTable,
  scopeTable,
  taskspaceTable,
} from "../../../db/schema.js";
import { NAME_MAX } from "../../../lib/constants.js";
import { findInventoryConflicts } from "../../../db/api/inventory.js";
import { allCardIds } from "../../lib/card-refs.js";
import { CARD_STAMP_EARLIEST, CARD_STAMP_LATEST } from "../../lib/card-sort.js";
import { plural } from "../../lib/plural.js";
import { shortIdMap } from "../../lib/short-id.js";

export type Check = { label: string; ok: boolean; detail?: string };

/** Maximum number of invalid cards to name alongside the total count. */
export const NAMED_BAD_STAMPS = 5;

/** Total number of cards with invalid timestamps and a sample of their short IDs. */
type BadStamps = { total: number; named: string[] };

/**
 * Find cards with timestamps outside {@link CARD_STAMP_EARLIEST} and {@link
 * CARD_STAMP_LATEST}. Share these bounds with the card listing so diagnostics use the same
 * range.
 *
 * Count all matching cards, then fetch at most {@link NAMED_BAD_STAMPS} IDs to keep the
 * report bounded.
 */
export async function badlyStampedCards(url: string): Promise<BadStamps> {
  const { db, close } = await openDb(url);
  try {
    const outsideRange = or(
      lt(cardTable.createdAt, CARD_STAMP_EARLIEST),
      gt(cardTable.createdAt, CARD_STAMP_LATEST),
      lt(cardTable.updatedAt, CARD_STAMP_EARLIEST),
      gt(cardTable.updatedAt, CARD_STAMP_LATEST),
    );
    const [counted] = await db.select({ total: count() }).from(cardTable).where(outsideRange);
    const total = counted?.total ?? 0;
    if (total === 0) return { total, named: [] };

    const worst = await db
      .select({ id: cardTable.id })
      .from(cardTable)
      .where(outsideRange)
      .limit(NAMED_BAD_STAMPS);
    // Read all IDs only when diagnostics need to name cards. `shortIdMap` requires the
    // complete set for unambiguous prefixes.
    const all = await db.select({ id: cardTable.id }).from(cardTable);
    const shortIds = shortIdMap(all.map(({ id }) => id));
    return { total, named: worst.map(({ id }) => shortIds.get(id) ?? id) };
  } finally {
    close();
  }
}

/**
 * Format a sample of IDs and the remaining count, such as `6fd3a2b, 41c0e9d and 3 more`.
 *
 * Accept the shared shape of {@link BadStamps} and {@link OverLimit}.
 */
export function nameSome({ total, named }: { total: number; named: string[] }): string {
  const rest = total - named.length;
  return rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", ");
}

/**
 * Check database structure and foreign-key references through a temporary read-only
 * connection.
 *
 * `integrity_check` reports damaged pages and inconsistent indexes. `foreign_key_check`
 * reports dangling references, including rows written by a connection with foreign-key
 * enforcement disabled. A structurally valid database can still contain those rows.
 *
 * Run these checks only on request. The integrity check scans the database and does not
 * belong in a request handler.
 */
export async function databaseIntegrity(url: string): Promise<{ ok: boolean; detail?: string }> {
  const client = createClient({ url });
  try {
    await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // A valid database returns one row containing "ok". Check its value because a damaged
    // database can also return a single row.
    const integrity = await client.execute("PRAGMA integrity_check");
    const problems = integrity.rows
      .map((row) => String(Object.values(row)[0] ?? ""))
      .filter((text) => text !== "ok");
    if (problems.length > 0)
      return {
        ok: false,
        detail: `${plural(problems.length, "problem")} reported by SQLite: ${problems
          .slice(0, NAMED_BAD_STAMPS)
          .join("; ")}; restore from a backup with kozane db restore`,
      };

    // Zero rows when sound. Each row names a child table and the parent it failed to find.
    const orphans = await client.execute("PRAGMA foreign_key_check");
    if (orphans.rows.length > 0) {
      const tables = [...new Set(orphans.rows.map((row) => String(Object.values(row)[0] ?? "?")))];
      return {
        ok: false,
        detail:
          `${plural(orphans.rows.length, "row")} referencing a row that does not exist, in ` +
          `${tables.join(", ")}; written by a client that had PRAGMA foreign_keys off. ` +
          "Export what is readable with kozane db export, then kozane db restore",
      };
    }

    return { ok: true };
  } finally {
    client.close();
  }
}

/** Count of rows exceeding one limit, with sample IDs. */
type OverLimit = { total: number; named: string[] };

const noneOverLimit: OverLimit = { total: 0, named: [] };

/**
 * Report stored rows that exceed the workspace's current text, name, or canvas limits.
 *
 * HTTP and CLI writes enforce these limits. Imports warn instead of rejecting rows so backups
 * from workspaces with different settings remain restorable. The schema does not enforce
 * these configurable limits.
 *
 * Cards over the text limit remain readable and movable, but their text must be shortened
 * before an edit can be saved.
 *
 * SQLite's `length()` counts characters, while JavaScript writers count UTF-16 code units.
 * This check can undercount text containing astral characters and miss cards that writers
 * would reject.
 */
export async function rowsOverLimits(
  url: string,
  limits: { contentMax: number; canvasWidth: number; canvasHeight: number },
): Promise<{ long: OverLimit; offBoard: OverLimit; names: OverLimit }> {
  const { db, close } = await openDb(url);
  try {
    const longContent = gt(sql`length(${cardTable.content})`, limits.contentMax);
    const offCanvas = or(
      lt(cardTable.posX, 0),
      lt(cardTable.posY, 0),
      gt(cardTable.posX, limits.canvasWidth),
      gt(cardTable.posY, limits.canvasHeight),
    );

    /**
     * Build short IDs at most once, and only if a condition needs to name cards. `shortIdMap`
     * needs every card ID to choose unambiguous prefixes.
     */
    let shortIds: Map<string, string> | null = null;
    const shortIdOf = async (id: string): Promise<string> => {
      shortIds ??= shortIdMap(
        (await db.select({ id: cardTable.id }).from(cardTable)).map((row) => row.id),
      );
      return shortIds.get(id) ?? id;
    };

    // `or()` returns `SQL | undefined` because it also accepts an empty set of conditions.
    // These arguments always provide conditions.
    const cardsMatching = async (where: SQL | undefined): Promise<OverLimit> => {
      const [counted] = await db.select({ total: count() }).from(cardTable).where(where);
      const total = counted?.total ?? 0;
      if (total === 0) return noneOverLimit;
      const worst = await db
        .select({ id: cardTable.id })
        .from(cardTable)
        .where(where)
        .limit(NAMED_BAD_STAMPS);
      // Use short IDs accepted by `kozane card show` and `card edit`.
      const named: string[] = [];
      for (const { id } of worst) named.push(await shortIdOf(id));
      return { total, named };
    };

    const long = await cardsMatching(longContent);
    const offBoard = await cardsMatching(offCanvas);

    // Count all named entities against the shared limit. Identify each match by table and
    // full ID, since its name is too long to print and short IDs would require separate maps
    // for each table.
    const named: string[] = [];
    let total = 0;
    for (const [label, table] of [
      ["namespace", namespaceTable],
      ["partition", partitionTable],
      ["layer", layerTable],
      ["scope", scopeTable],
      ["taskspace", taskspaceTable],
    ] as const) {
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(gt(sql`length(${table.name})`, NAME_MAX));
      total += rows.length;
      for (const { id } of rows) if (named.length < NAMED_BAD_STAMPS) named.push(`${label} ${id}`);
    }

    return { long, offBoard, names: { total, named } };
  } finally {
    close();
  }
}

/**
 * Stored cards that overlap or are still glued, and cards with only one inventory column set,
 * each counted with a sample of short IDs. See {@link findInventoryConflicts}.
 */
export async function inventoryConflicts(
  url: string,
): Promise<{ overlapping: BadStamps; glued: BadStamps; halfPlaced: BadStamps }> {
  const { db, close } = await openDb(url);
  try {
    const conflicts = await findInventoryConflicts({ db });
    const none = { total: 0, named: [] };
    if (Object.values(conflicts).every((ids) => ids.length === 0))
      return { overlapping: none, glued: none, halfPlaced: none };
    // Use short IDs accepted by `kozane inventory take`.
    const shortIds = shortIdMap(await allCardIds(db));
    const sample = (ids: string[]): BadStamps => ({
      total: ids.length,
      named: ids.slice(0, NAMED_BAD_STAMPS).map((id) => shortIds.get(id) ?? id),
    });
    return {
      overlapping: sample(conflicts.overlapping),
      glued: sample(conflicts.glued),
      halfPlaced: sample(conflicts.halfPlaced),
    };
  } finally {
    close();
  }
}

/**
 * Namespaces missing their default partition or default layer. Every writer creates both with
 * the namespace, but raw SQL or an older import can leave one out, and then adding a card
 * without a partition or layer, or deleting one, fails.
 */
export async function namespacesWithoutDefaults(
  url: string,
): Promise<{ partition: string[]; layer: string[] }> {
  const { db, close } = await openDb(url);
  try {
    const missing = async (table: typeof partitionTable | typeof layerTable) =>
      (
        await db
          .select({ id: namespaceTable.id })
          .from(namespaceTable)
          .where(
            sql`NOT EXISTS (SELECT 1 FROM ${table} WHERE ${table.namespaceId} = ${namespaceTable.id} AND ${table.isDefault} = 1)`,
          )
      ).map(({ id }) => id);
    return { partition: await missing(partitionTable), layer: await missing(layerTable) };
  } finally {
    close();
  }
}

export function check(label: string, ok: boolean, detail?: string): Check {
  return { label, ok, detail };
}

export function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection({ host, port }, () => {
      conn.destroy();
      resolve(false); // port in use
    });
    conn.on("error", () => resolve(true)); // port free
    conn.setTimeout(500, () => {
      conn.destroy();
      resolve(true);
    });
  });
}
