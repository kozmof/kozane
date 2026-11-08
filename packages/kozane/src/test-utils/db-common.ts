import { sql } from "drizzle-orm";
import type { DB, Tx } from "../db/database.js";

/** Triggers migration 0019 adds to `card`. */
export const CARD_GUARD_TRIGGERS = [
  "card_inventory_pair_insert",
  "card_inventory_pair_update",
  "card_inventory_clear_slot",
  "card_stamp_missing_timestamps",
] as const;

/** Statements that remove the 0019 triggers, for raw clients outside Drizzle. */
export const DROP_CARD_GUARDS_SQL = CARD_GUARD_TRIGGERS.map(
  (name) => `DROP TRIGGER IF EXISTS \`${name}\``,
);

/**
 * Remove the 0019 triggers so a test can write the rows a database from before them may
 * still hold, such as a card with only one inventory column set.
 */
export async function dropCardGuards(db: DB | Tx): Promise<void> {
  for (const statement of DROP_CARD_GUARDS_SQL) await db.run(sql.raw(statement));
}

/**
 * SQLite's bound-parameter limit, checked against the driver. Tests that exceed it distinguish
 * namespace queries from queries that bind a list of card IDs.
 */
export const SQLITE_VARIABLE_MAX = 32_766;

/**
 * Insert `count` cards into one partition and layer with a recursive CTE. This creates large
 * fixtures without the round trips required by individual data API writes. Return IDs in
 * insertion order.
 */
export async function seedCards(
  db: DB | Tx,
  { partitionId, layerId, count, prefix = "card" }: SeedCards,
): Promise<string[]> {
  if (count <= 0) return [];
  await db.run(sql`
    WITH RECURSIVE seq(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${count}
    )
    INSERT INTO card (id, partition_id, layer_id, content, pos_x, pos_y, z_index, created_at, updated_at)
    SELECT ${prefix} || '-' || n, ${partitionId}, ${layerId}, 'card ' || n, 0, 0, 0, unixepoch(), unixepoch() FROM seq
  `);
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

type SeedCards = {
  partitionId: string;
  layerId: string;
  count: number;
  /** Prefix used to keep seeded card IDs distinct across partitions. */
  prefix?: string;
};

/**
 * Recognize SQLite's parameter-count error through Drizzle's cause chain so unrelated query
 * failures cannot satisfy the assertion.
 */
export function isTooManyVariables(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /too many SQL variables/i.test(e.message) || isTooManyVariables(e.cause);
}
