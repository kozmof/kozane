import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { runWorkspaceCommand } from "../lib/workspace-command.js";
import { partitionTable, cardTable, namespaceTable, scopeTable } from "../../db/schema.js";
import {
  addCard,
  addCards,
  reassignCardsToPartition,
  reassignCardsToLayer,
  updateCard,
  updateNamespaceCardPositions,
} from "../../db/api/card.js";
import {
  getGlueRelsByNamespace,
  glueNamespaceCards,
  unglueNamespaceCards,
} from "../../db/api/glue.js";
import { getAllLayers } from "../../db/api/layer.js";
import {
  addScopeRel,
  addScopeRels,
  getCardsByScopeWithPartitionName,
} from "../../db/api/scope-rel.js";
import { getTaskspace } from "../../db/api/taskspace.js";
import { findById, resolveShortId, shortId, shortIdMap } from "../lib/short-id.js";
import {
  loadCards,
  movedCoordinate,
  resolvePartitionId,
  resolveCardGroup,
  resolveLayerId,
  resolveScopeId,
} from "../lib/card-refs.js";
import { printCards, type ListedCard, type NearestCard } from "../lib/card-print.js";
import {
  CARD_SORT_KEYS,
  sortCards,
  sortColumn,
  type CardSortKey,
  type CardStamps,
  type CardTimes,
} from "../lib/card-sort.js";
import { compareIds } from "../../lib/order.js";
import { resolveLayerRef } from "../lib/layer-ref.js";
import { readTaskspaceMarker } from "../lib/taskspace-marker.js";
import { withTx } from "../../db/tx.js";
import { splitCardContent, squashCardPositions } from "../../lib/squash.js";
import { resolveNamespaceId } from "../lib/namespace-selection.js";
import { contentLimitIssue } from "../../lib/constants.js";
import { canvasBoundsForRoot, clampToBounds } from "../../lib/server/canvas.js";
import { contentMaxForRoot } from "../../lib/server/content-limit.js";
import { getUiConfigForRoot } from "../../db/internal/config.js";
import { estimateCardHeight } from "../../lib/warp-list.js";
import { deleteNamespaceCards, moveCardsToNamespace } from "../../db/api/composite.js";
import { getAllNamespaces } from "../../db/api/namespace.js";
import { getAllPartitions } from "../../db/api/partition.js";

/** The board grid used by card movement and vertical-list placement in the browser. */
const GRID = 24;

type CardOptions = {
  namespace?: string;
  partition?: string;
  taskspace?: string;
  sort?: CardSortKey;
  reverse?: boolean;
};
type CardAddOptions = Omit<CardOptions, "taskspace"> & {
  scope?: string;
  layer?: string;
  x?: number;
  y?: number;
};
type CardSquashOptions = Omit<CardAddOptions, "x" | "y"> & { pattern?: string };
type CardShowOptions = { times?: boolean };
type CardGlueOptions = { add?: boolean; alignList?: boolean };
type CardMoveOptions = { x?: number | string; y?: number | string };

export async function cardAdd(content: string, options: CardAddOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    // Validate against the workspace's `ui.contentMax` after loading its configuration.
    const contentIssue = contentLimitIssue(content, contentMaxForRoot(root));
    if (contentIssue) throw new Error(contentIssue);

    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const partitionId = await resolvePartitionId(db, namespaceId, options.partition);
    const layerId = await resolveLayerId(db, namespaceId, options.layer);
    const scopeId = options.scope ? await resolveScopeId(db, options.scope) : undefined;
    // Clamp `--x` and `--y` to the workspace's board bounds so the viewport can reach the card.
    const placement = clampToBounds(options.x ?? 0, options.y ?? 0, canvasBoundsForRoot(root));
    const id = await withTx(db, async (tx) => {
      const cardId = await addCard({
        db: tx,
        partitionId,
        layerId,
        content,
        ...placement,
      });
      if (scopeId) await addScopeRel({ db: tx, scopeId, cardId });
      return cardId;
    });
    const [namespaces, partitions, cards, scopes, layers] = await Promise.all([
      db.select({ id: namespaceTable.id }).from(namespaceTable),
      db.select({ id: partitionTable.id }).from(partitionTable),
      db.select({ id: cardTable.id }).from(cardTable),
      scopeId ? db.select({ id: scopeTable.id }).from(scopeTable) : Promise.resolve([]),
      getAllLayers({ db, namespaceId }),
    ]);
    console.log("Card added.");
    console.log(
      `  id      : ${shortId(
        id,
        cards.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  namespace : ${shortId(
        namespaceId,
        namespaces.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  partition  : ${shortId(
        partitionId,
        partitions.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  layer   : ${shortId(
        layerId,
        layers.map(({ id }) => id),
      )}`,
    );
    if (scopeId)
      console.log(
        `  scope   : ${shortId(
          scopeId,
          scopes.map(({ id }) => id),
        )}`,
      );
  });
}

export async function cardSquash(
  content: string | undefined,
  options: CardSquashOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const contents = splitCardContent(content ?? readFileSync(0, "utf8"), options.pattern);
    if (contents.length === 0) throw new Error("Content must contain at least one non-empty card.");

    // Check every segment against the workspace's `ui.contentMax` before writing any cards.
    // Report failures by segment position so they can be found in the input.
    const limit = contentMaxForRoot(root);
    for (const [index, segment] of contents.entries()) {
      const issue = contentLimitIssue(segment, limit);
      if (issue) throw new Error(`Card ${index + 1} of ${contents.length}: ${issue}`);
    }

    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const partitionId = await resolvePartitionId(db, namespaceId, options.partition);
    const layerId = await resolveLayerId(db, namespaceId, options.layer);
    const scopeId = options.scope ? await resolveScopeId(db, options.scope) : undefined;
    const occupied = await db
      .select({ posX: cardTable.posX, posY: cardTable.posY })
      .from(cardTable)
      .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
      .where(eq(partitionTable.namespaceId, namespaceId));
    // Lay out columns using the workspace's `ui.canvasWidth`, then clamp overflowing rows to
    // the board. `squashNamespaceCard` uses the same steps.
    const bounds = canvasBoundsForRoot(root);
    const positions = squashCardPositions(occupied, contents.length, {
      canvasWidth: bounds.canvasWidth,
    });
    const ids = await withTx(db, async (tx) => {
      const cardIds = await addCards({
        db: tx,
        partitionId,
        layerId,
        cards: contents.map((cardContent, index) => ({
          content: cardContent,
          ...clampToBounds(positions[index].posX, positions[index].posY, bounds),
        })),
      });
      if (scopeId) await addScopeRels({ db: tx, scopeId, cardIds });
      return cardIds;
    });

    const allCards = await db.select({ id: cardTable.id }).from(cardTable);
    const shortIds = shortIdMap(allCards.map(({ id }) => id));
    console.log(`${ids.length} ${ids.length === 1 ? "card" : "cards"} added.`);
    for (const id of ids) console.log(`  ${shortIds.get(id) ?? id}`);
  });
}

/**
 * Moves an existing card to another layer of its own namespace. The namespace is taken from
 * the card rather than from `--namespace`, so the layer is always resolved against the
 * namespace that actually owns the card.
 */
export async function cardSetLayer(requestedCardId: string, requestedLayer: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const cards = await db
      .select({ id: cardTable.id, namespaceId: partitionTable.namespaceId })
      .from(cardTable)
      .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id));
    const cardId = resolveShortId(
      requestedCardId,
      cards.map(({ id }) => id),
      "Card",
    );
    const { namespaceId } = findById(cards, cardId, "Card");
    const layers = await getAllLayers({ db, namespaceId });
    const layerId = resolveLayerRef(layers, requestedLayer);

    if (!(await reassignCardsToLayer({ db, namespaceId, cardIds: [cardId], layerId })).ok)
      throw new Error("Card and layer do not belong to the same namespace.");

    const layer = findById(layers, layerId, "Layer");
    console.log("Card moved to another layer.");
    console.log(
      `  id   : ${shortId(
        cardId,
        cards.map(({ id }) => id),
      )}`,
    );
    console.log(`  layer: ${layer.name}`);
  });
}

export async function cardMove(requestedCardId: string, { x, y }: CardMoveOptions): Promise<void> {
  if (x === undefined && y === undefined) throw new Error("card move requires --x or --y.");
  await runWorkspaceCommand(async ({ db, root }) => {
    const { allIds, cardIds, namespaceId } = await resolveCardGroup(db, [requestedCardId]);
    const cardId = cardIds[0];
    const card = findById(await loadCards(db, cardIds), cardId, "Card");
    const position = clampToBounds(
      x === undefined ? card.posX : movedCoordinate(x, card.posX),
      y === undefined ? card.posY : movedCoordinate(y, card.posY),
      canvasBoundsForRoot(root),
    );
    const result = await updateNamespaceCardPositions({
      db,
      namespaceId,
      positions: [{ cardId, ...position }],
    });
    if (!result.ok) throw new Error("Card does not belong to the namespace.");

    console.log("Card moved.");
    console.log(`  id: ${shortId(cardId, allIds)}`);
    console.log(`  position: (${position.posX}, ${position.posY})`);
  });
}

export async function cardEdit(requestedCardId: string, content: string): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const issue = contentLimitIssue(content, contentMaxForRoot(root));
    if (issue) throw new Error(issue);
    const { allIds, cardIds } = await resolveCardGroup(db, [requestedCardId]);
    // `resolveShortId` already established that this id names a card, so there is no row to
    // look up here beyond the partition the update has to name.
    const cardId = cardIds[0];
    const row = await db
      .select({ partitionId: cardTable.partitionId })
      .from(cardTable)
      .where(eq(cardTable.id, cardId))
      .get();
    if (!row) throw new Error(`Card not found: ${requestedCardId}`);
    await updateCard({ db, cardId, partitionId: row.partitionId, content });
    console.log("Card updated.");
    console.log(`  id: ${shortId(cardId, allIds)}`);
  });
}

export async function cardDelete(requestedIds: string[]): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const { allIds, cardIds, namespaceId } = await resolveCardGroup(db, requestedIds);
    const result = await deleteNamespaceCards({ db, namespaceId, cardIds });
    if (!result.ok) throw new Error("Cards must belong to the same namespace.");
    console.log(`${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} deleted.`);
    for (const cardId of cardIds) console.log(`  card: ${shortId(cardId, allIds)}`);
  });
}

export async function cardSetPartition(
  requestedPartitionId: string,
  requestedCardIds: string[],
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const { cardIds, namespaceId } = await resolveCardGroup(db, requestedCardIds);
    const partitions = await getAllPartitions({ db, namespaceId });
    const partitionId = resolveShortId(
      requestedPartitionId,
      partitions.map(({ id }) => id),
      "Partition",
    );
    const result = await reassignCardsToPartition({ db, namespaceId, cardIds, partitionId });
    if (!result.ok)
      throw new Error(
        result.reason === "foreign-cards"
          ? "Cards must belong to the same namespace."
          : "Partition does not belong to the cards' namespace.",
      );
    console.log(`${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} moved to partition.`);
    console.log(
      `  partition: ${shortId(
        partitionId,
        partitions.map(({ id }) => id),
      )}`,
    );
  });
}

export async function cardSetNamespace(
  requestedNamespaceId: string,
  requestedCardIds: string[],
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const { cardIds, namespaceId: sourceNamespaceId } = await resolveCardGroup(
      db,
      requestedCardIds,
    );
    const namespaces = await getAllNamespaces({ db });
    const targetNamespaceId = resolveShortId(
      requestedNamespaceId,
      namespaces.map(({ id }) => id),
      "Namespace",
    );
    const result = await moveCardsToNamespace({
      db,
      sourceNamespaceId,
      targetNamespaceId,
      cardIds,
    });
    if (!result.ok) throw new Error("Cards must belong to the same source namespace.");
    console.log(`${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} moved to namespace.`);
    console.log(
      `  namespace: ${shortId(
        targetNamespaceId,
        namespaces.map(({ id }) => id),
      )}`,
    );
  });
}

export async function cardGlue(
  requestedIds: string[],
  options: CardGlueOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const {
      index,
      allIds,
      cardIds: requestedCardIds,
      namespaceId,
    } = await resolveCardGroup(db, requestedIds);
    if (
      requestedCardIds.some((cardId) => findById(index, cardId, "Card").namespaceId !== namespaceId)
    )
      throw new Error("Cards must belong to the same namespace.");

    let cardIds = requestedCardIds;
    if (options.add) {
      const rels = await getGlueRelsByNamespace({ db, namespaceId });
      const glueIdByCardId = new Map(rels.map((rel) => [rel.cardId, rel.glueId]));
      // Build groups from the workspace index to preserve card order when choosing anchors and
      // printing members.
      const membersByGlueId = new Map<string, string[]>();
      for (const card of index) {
        const glueId = glueIdByCardId.get(card.id);
        if (glueId) membersByGlueId.set(glueId, [...(membersByGlueId.get(glueId) ?? []), card.id]);
      }
      cardIds = [
        ...new Set(
          requestedCardIds.flatMap((cardId) => {
            const glueId = glueIdByCardId.get(cardId);
            return glueId ? (membersByGlueId.get(glueId) ?? [cardId]) : [cardId];
          }),
        ),
      ];
    }

    const result = await glueNamespaceCards({ db, namespaceId, cardIds });
    if (!result.ok) throw new Error("Cards must belong to the same namespace.");

    if (options.alignList) {
      const ui = getUiConfigForRoot(root);
      const bounds = canvasBoundsForRoot(root);
      // Read text and width only for this branch, after `--add` has determined the expanded
      // card set.
      const detailed = await loadCards(db, cardIds);
      const byId = new Map(detailed.map((card) => [card.id, card]));
      const anchor = findById(detailed, cardIds[0], "Card");
      let nextY = anchor.posY;
      const positions = cardIds.map((cardId) => {
        const card = byId.get(cardId);
        if (!card) throw new Error(`Card not found: ${cardId}`);
        const position = clampToBounds(anchor.posX, nextY, bounds);
        nextY =
          Math.ceil(
            (position.posY +
              estimateCardHeight(card.content, {
                cardWidth: card.width ?? ui.defaultCardWidth,
                fontSize: ui.defaultFontSize,
              }) +
              GRID) /
              GRID,
          ) * GRID;
        return { cardId, ...position };
      });
      const moved = await updateNamespaceCardPositions({ db, namespaceId, positions });
      if (!moved.ok) throw new Error("Cards must belong to the same namespace.");
    }

    console.log(`${cardIds.length} cards glued.`);
    if (options.add) console.log("  mode: additive");
    if (options.alignList) console.log("  layout: vertical list");
    console.log(`  glue: ${shortId(result.glueId, [result.glueId])}`);
    for (const cardId of cardIds) console.log(`  card: ${shortId(cardId, allIds)}`);
  });
}

export async function cardUnglue(requestedIds: string[]): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const { allIds, cardIds, namespaceId } = await resolveCardGroup(db, requestedIds);
    const result = await unglueNamespaceCards({ db, namespaceId, cardIds });
    if (!result.ok) throw new Error("Cards must belong to the same namespace.");
    console.log(`${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} unglued.`);
    for (const cardId of cardIds) console.log(`  card: ${shortId(cardId, allIds)}`);
  });
}

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
  // The text is what this command exists to print, so it is kept a block of its own.
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

    // Now the text, for the one namespace that is about to be printed.
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
