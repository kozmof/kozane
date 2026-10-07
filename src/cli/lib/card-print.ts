import { cardTable } from "../../db/schema.js";
import type { DB } from "../../db/tx.js";
import { shortIdMap } from "./short-id.js";
import type { CardTimes } from "./card-sort.js";

/** Shared CLI card-list formatting, separate from command execution. */

/** Card fields required by every listing. */
export type PrintableCard = {
  id: string;
  partition: string;
  content: string;
  posX: number;
  posY: number;
};
/** Card columns needed to print and sort all three `card list` query results. */
export type ListedCard = PrintableCard & CardTimes;
/** Printable card fields and distance for `card nearest`. */
export type NearestCard = PrintableCard & { distance: number };

/**
 * Print one row per card. An optional formatter adds a column between coordinates and text
 * for distance or sorting values. Without it, preserve the default ID, partition, coordinate,
 * and text columns.
 *
 * Type the formatter against the caller's card shape so it cannot read fields missing from
 * the result.
 */
export async function printCards<T extends PrintableCard>(
  db: DB,
  cards: T[],
  column?: (card: T) => string,
): Promise<void> {
  if (cards.length === 0) {
    console.log("No cards found.");
    return;
  }
  const allCards = await db.select({ id: cardTable.id }).from(cardTable);
  const shortIds = shortIdMap(allCards.map(({ id }) => id));
  for (const card of cards) {
    const extra = column ? `${column(card)}  ` : "";
    console.log(
      `${shortIds.get(card.id) ?? card.id}  ${card.partition}  (${card.posX}, ${card.posY})  ${extra}${card.content.replace(/\r?\n/g, " ")}`,
    );
  }
}
