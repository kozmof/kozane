/** `kozane card show`, `kozane card nearest`, and `kozane card list`. */
import { and, eq } from "drizzle-orm";
import { runWorkspaceCommand } from "../../lib/workspace-command.js";
import { partitionTable, cardTable } from "../../../db/schema.js";
import { getCardsByScopeWithPartitionName } from "../../../db/api/scope-rel.js";
import { getTaskspace } from "../../../db/api/taskspace.js";
import { findById, resolveShortId } from "../../lib/short-id.js";
import { resolvePartitionId } from "../../lib/card-refs.js";
import { printCards, type ListedCard, type NearestCard } from "../../lib/card-print.js";
import {
  CARD_SORT_KEYS,
  sortCards,
  sortColumn,
  type CardStamps,
  type CardTimes,
} from "../../lib/card-sort.js";
import { compareIds } from "../../../lib/order.js";
import { readTaskspaceMarker } from "../../lib/taskspace-marker.js";
import { resolveNamespaceId } from "../../lib/namespace-selection.js";
import { type CardOptions, type CardShowOptions } from "./options.js";

/**
 * Print the `--times` header with the same `sortColumn` formatter as `card list --sort`,
 * including its handling of invalid timestamps. Include the derived `gap` alongside the stored
 * timestamps.
 *
 * Measure label width from `CARD_SORT_KEYS` so adding a sort key needs no separate width
 * change.
 */
const KEY_LABEL_WIDTH = Math.max(...CARD_SORT_KEYS.map((key) => key.length));

function printCardTimes(card: CardStamps): void {
  for (const key of CARD_SORT_KEYS)
    console.log(`${key.padEnd(KEY_LABEL_WIDTH)}  ${sortColumn(card, key)}`);
  // Print card text in a separate block from its metadata.
  console.log("");
}

export async function cardShow(requestedId: string, options: CardShowOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    // Resolve short IDs using only the workspace's ID column. Fetch text separately for the
    // requested card.
    const cards = await db.select({ id: cardTable.id }).from(cardTable);
    const cardId = resolveShortId(
      requestedId,
      cards.map(({ id }) => id),
      "Card",
    );
    const card = await db
      .select({
        content: cardTable.content,
        createdAt: cardTable.createdAt,
        updatedAt: cardTable.updatedAt,
      })
      .from(cardTable)
      .where(eq(cardTable.id, cardId))
      .get();
    // Handle absence explicitly because this second query can differ from the ID-resolution
    // result.
    if (!card) throw new Error(`Card not found: ${requestedId}`);
    // Print history only when requested so redirecting the default output writes just the card
    // text.
    if (options.times) printCardTimes(card);
    console.log(card.content);
  });
}

export async function cardNearest(requestedId: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    // Read positions and IDs first to resolve the origin. Fetch text only for the namespace
    // being printed.
    const placed = await db
      .select({
        id: cardTable.id,
        namespaceId: partitionTable.namespaceId,
        posX: cardTable.posX,
        posY: cardTable.posY,
      })
      .from(cardTable)
      .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id));
    const cardId = resolveShortId(
      requestedId,
      placed.map(({ id }) => id),
      "Card",
    );
    const origin = findById(placed, cardId, "Card");

    // Fetch text only for the namespace being printed.
    const cards = await db
      .select({
        id: cardTable.id,
        partition: partitionTable.name,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
      })
      .from(cardTable)
      .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
      .where(eq(partitionTable.namespaceId, origin.namespaceId));
    // Break equal distances with `compareIds`, as the card and layer sorters do. See
    // `lib/order.ts` for the ordering rule.
    const sorted: NearestCard[] = cards
      .map((card) => ({
        ...card,
        distance: Math.hypot(card.posX - origin.posX, card.posY - origin.posY),
      }))
      .sort((a, b) => a.distance - b.distance || compareIds(a.id, b.id));
    await printCards(db, sorted, (card) => card.distance.toFixed(2));
  });
}

export async function cardList(options: CardOptions = {}): Promise<void> {
  // Validate workspace-independent options before `runWorkspaceCommand`. A malformed command
  // should report its option error even outside a workspace.
  //
  // Throw so callers can test validation without exiting. The action's `.catch(fail)` in
  // `program.ts` reports the error and sets the exit code.
  const { sort, reverse } = options;
  if (options.taskspace && (options.namespace || options.partition))
    throw new Error("--taskspace cannot be combined with --namespace or --partition.");
  // Without a sort key, SQLite's row order is unspecified and cannot be meaningfully reversed.
  if (reverse && !sort) throw new Error("--reverse requires --sort.");

  // Apply the same sort and time-column formatter to namespace and taskspace listings.
  const ordered = <T extends ListedCard>(cards: T[]): T[] =>
    sort ? sortCards(cards, sort, reverse) : cards;
  const timeColumn = sort ? (card: CardTimes) => sortColumn(card, sort) : undefined;

  await runWorkspaceCommand(async ({ db }) => {
    const locatedMarker =
      options.taskspace || (!options.namespace && !options.partition)
        ? readTaskspaceMarker(options.taskspace)
        : null;

    if (locatedMarker) {
      const taskspace = await getTaskspace({
        db,
        taskspaceId: locatedMarker.marker.taskspaceId,
      });
      if (!taskspace)
        throw new Error(`Taskspace is not registered in this workspace: ${locatedMarker.path}`);
      if (taskspace.scopeId) {
        const scopedCards = await getCardsByScopeWithPartitionName({
          db,
          scopeId: taskspace.scopeId,
        });
        await printCards(
          db,
          ordered(scopedCards.map((card) => ({ ...card, partition: card.partitionName }))),
          timeColumn,
        );
      } else {
        console.warn(
          "Notice: Taskspace is not attached to a scope. The scope may have been deleted.",
        );
        const taskspaceCards = await db
          .select({
            id: cardTable.id,
            partition: partitionTable.name,
            content: cardTable.content,
            posX: cardTable.posX,
            posY: cardTable.posY,
            createdAt: cardTable.createdAt,
            updatedAt: cardTable.updatedAt,
          })
          .from(cardTable)
          .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
          .where(eq(cardTable.taskspaceId, taskspace.id));
        await printCards(db, ordered(taskspaceCards), timeColumn);
      }
      return;
    }

    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const conditions = [eq(partitionTable.namespaceId, namespaceId)];
    if (options.partition) {
      const partitionId = await resolvePartitionId(db, namespaceId, options.partition);
      conditions.push(eq(partitionTable.id, partitionId));
    }
    const cards = await db
      .select({
        id: cardTable.id,
        partition: partitionTable.name,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
        createdAt: cardTable.createdAt,
        updatedAt: cardTable.updatedAt,
      })
      .from(cardTable)
      .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
      .where(and(...conditions));
    await printCards(db, ordered(cards), timeColumn);
  });
}
