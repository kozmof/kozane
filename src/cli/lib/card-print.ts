import { cardTable } from "../../db/schema.js";
import type { DB } from "../../db/tx.js";
import { shortIdMap } from "./short-id.js";
import type { CardTimes } from "./card-sort.js";

/**
 * How the CLI draws a list of cards.
 *
 * Beside `card-refs.ts` and out of `commands/card.ts` for the same two reasons: a command
 * module should hold commands, and this is plain formatting over rows that the coverage
 * exclusion on `cli/commands/**` was hiding for no reason of its own.
 */

/** What {@link printCards} needs of a card: the fields every listing prints. */
export type PrintableCard = {
  id: string;
  bundle: string;
  content: string;
  posX: number;
  posY: number;
};
/** What `card list` selects on every one of its three paths — printable, plus what `--sort` reads. */
export type ListedCard = PrintableCard & CardTimes;
/** What `card nearest` prints: printable, plus the distance it ordered by. */
export type NearestCard = PrintableCard & { distance: number };

/**
 * Prints one line per card, with one extra column between the position and the text when
 * the caller passes something to fill it: the distance for `card nearest`, the value it
 * ordered by for `card list --sort`.
 *
 * A listing that asked for neither prints exactly what it printed before either column
 * existed: `<id>  <bundle>  (<x>, <y>)  <text>`.
 *
 * The column arrives as a function of the card rather than as a flag this reads a field
 * for, so it is the caller's card shape that decides what can be printed: a column reading
 * `createdAt` cannot be handed cards that carry no timestamps, which asking for a sort key
 * beside a loosely-typed union of card shapes allowed.
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
      `${shortIds.get(card.id) ?? card.id}  ${card.bundle}  (${card.posX}, ${card.posY})  ${extra}${card.content.replace(/\r?\n/g, " ")}`,
    );
  }
}
