import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { runWorkspaceCommand } from "../lib/workspace-command.js";
import { bundleTable, cardTable, projectTable, scopeTable } from "../../db/schema.js";
import {
  addCard,
  addCards,
  reassignCardsToLayer,
  updateProjectCardPositions,
} from "../../db/api/card.js";
import { getGlueRelsByProject, glueProjectCards, unglueProjectCards } from "../../db/api/glue.js";
import { getDefaultBundle } from "../../db/api/bundle.js";
import { getAllLayers } from "../../db/api/layer.js";
import {
  addScopeRel,
  addScopeRels,
  getCardsByScopeWithBundleName,
} from "../../db/api/scope-rel.js";
import { getTaskspace } from "../../db/api/taskspace.js";
import { findById, resolveShortId, shortId, shortIdMap } from "../lib/short-id.js";
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
import { withTx, type DB } from "../../db/tx.js";
import { splitCardContent, squashCardPositions } from "../../lib/squash.js";
import { resolveProjectId } from "../lib/project-selection.js";
import { contentLimitIssue } from "../../lib/constants.js";
import { canvasBoundsForRoot, clampToBounds } from "../../lib/server/canvas.js";
import { contentMaxForRoot } from "../../lib/server/content-limit.js";
import { getUiConfigForRoot } from "../../db/internal/config.js";
import { estimateCardHeight } from "../../lib/warp-list.js";

/** The board grid used by card movement and vertical-list placement in the browser. */
const GRID = 24;

type CardOptions = {
  project?: string;
  bundle?: string;
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

/** Resolve card references together and retain the project needed by the guarded glue APIs. */
async function resolveCardGroup(db: DB, requestedIds: string[]) {
  const cards = await db
    .select({
      id: cardTable.id,
      projectId: bundleTable.projectId,
      content: cardTable.content,
      width: cardTable.width,
      posX: cardTable.posX,
      posY: cardTable.posY,
    })
    .from(cardTable)
    .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id));
  const allIds = cards.map(({ id }) => id);
  const cardIds = requestedIds.map((id) => resolveShortId(id, allIds, "Card"));
  const projectId = findById(cards, cardIds[0], "Card").projectId;
  return { cards, cardIds, projectId };
}

/** What {@link printCards} needs of a card: the fields every listing prints. */
type PrintableCard = {
  id: string;
  bundle: string;
  content: string;
  posX: number;
  posY: number;
};
/** What `card list` selects on every one of its three paths — printable, plus what `--sort` reads. */
type ListedCard = PrintableCard & CardTimes;
/** What `card nearest` prints: printable, plus the distance it ordered by. */
type NearestCard = PrintableCard & { distance: number };

async function resolveBundleId(db: DB, projectId: string, requestedId?: string): Promise<string> {
  if (requestedId) {
    const bundles = await db
      .select({ id: bundleTable.id })
      .from(bundleTable)
      .where(eq(bundleTable.projectId, projectId));
    return resolveShortId(
      requestedId,
      bundles.map(({ id }) => id),
      "Bundle",
    );
  }
  const bundle = await getDefaultBundle({ db, projectId });
  if (!bundle) throw new Error(`Project has no default bundle: ${projectId}`);
  return bundle.id;
}

/** The requested layer, or the project's default one when nothing was asked for. */
async function resolveLayerId(db: DB, projectId: string, requested?: string): Promise<string> {
  const layers = await getAllLayers({ db, projectId });
  if (!requested) {
    const defaultLayer = layers.find(({ isDefault }) => isDefault);
    if (!defaultLayer) throw new Error(`Project has no default layer: ${projectId}`);
    return defaultLayer.id;
  }
  return resolveLayerRef(layers, requested);
}

async function resolveScopeId(db: DB, requestedId: string): Promise<string> {
  const scopes = await db.select({ id: scopeTable.id }).from(scopeTable);
  return resolveShortId(
    requestedId,
    scopes.map(({ id }) => id),
    "Scope",
  );
}

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
async function printCards<T extends PrintableCard>(
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

export async function cardAdd(content: string, options: CardAddOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    // Held against this workspace's `ui.contentMax`, which is why the check waits for the
    // workspace rather than running on the way in.
    const contentIssue = contentLimitIssue(content, contentMaxForRoot(root));
    if (contentIssue) throw new Error(contentIssue);

    const projectId = await resolveProjectId(db, options.project);
    const bundleId = await resolveBundleId(db, projectId, options.bundle);
    const layerId = await resolveLayerId(db, projectId, options.layer);
    const scopeId = options.scope ? await resolveScopeId(db, options.scope) : undefined;
    // `--x`/`--y` are held to the board the same way the create endpoint holds a dragged
    // card, and against the same workspace bounds: a position outside them is one the
    // viewport can never scroll to, so a card stored there is a card nobody can find.
    const placement = clampToBounds(options.x ?? 0, options.y ?? 0, canvasBoundsForRoot(root));
    const id = await withTx(db, async (tx) => {
      const cardId = await addCard({
        db: tx,
        bundleId,
        layerId,
        content,
        ...placement,
      });
      if (scopeId) await addScopeRel({ db: tx, scopeId, cardId });
      return cardId;
    });
    const [projects, bundles, cards, scopes, layers] = await Promise.all([
      db.select({ id: projectTable.id }).from(projectTable),
      db.select({ id: bundleTable.id }).from(bundleTable),
      db.select({ id: cardTable.id }).from(cardTable),
      scopeId ? db.select({ id: scopeTable.id }).from(scopeTable) : Promise.resolve([]),
      getAllLayers({ db, projectId }),
    ]);
    console.log("Card added.");
    console.log(
      `  id      : ${shortId(
        id,
        cards.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  project : ${shortId(
        projectId,
        projects.map(({ id }) => id),
      )}`,
    );
    console.log(
      `  bundle  : ${shortId(
        bundleId,
        bundles.map(({ id }) => id),
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

    // Each segment becomes a card of its own, so each is held to the limit a card is held
    // to — this workspace's `ui.contentMax`. Reported by position, the only thing that
    // tells one segment of a piped file from another, and checked before anything is
    // written so a refusal leaves the board alone.
    const limit = contentMaxForRoot(root);
    for (const [index, segment] of contents.entries()) {
      const issue = contentLimitIssue(segment, limit);
      if (issue) throw new Error(`Card ${index + 1} of ${contents.length}: ${issue}`);
    }

    const projectId = await resolveProjectId(db, options.project);
    const bundleId = await resolveBundleId(db, projectId, options.bundle);
    const layerId = await resolveLayerId(db, projectId, options.layer);
    const scopeId = options.scope ? await resolveScopeId(db, options.scope) : undefined;
    const occupied = await db
      .select({ posX: cardTable.posX, posY: cardTable.posY })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
      .where(eq(bundleTable.projectId, projectId));
    // The workspace's own board, not the built-in default: `ui.canvasWidth` decides how
    // many columns the layout wraps at, and laying out against 5600 on a board configured
    // narrower puts the right-hand columns past its edge. Clamped afterwards for the rows,
    // which run downwards without a wrap to stop them — the same pair of steps
    // `squashProjectCard` takes for the board's own squash.
    const bounds = canvasBoundsForRoot(root);
    const positions = squashCardPositions(occupied, contents.length, {
      canvasWidth: bounds.canvasWidth,
    });
    const ids = await withTx(db, async (tx) => {
      const cardIds = await addCards({
        db: tx,
        bundleId,
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
 * Moves an existing card to another layer of its own project. The project is taken from
 * the card rather than from `--project`, so the layer is always resolved against the
 * project that actually owns the card.
 */
export async function cardSetLayer(requestedCardId: string, requestedLayer: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const cards = await db
      .select({ id: cardTable.id, projectId: bundleTable.projectId })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id));
    const cardId = resolveShortId(
      requestedCardId,
      cards.map(({ id }) => id),
      "Card",
    );
    const { projectId } = findById(cards, cardId, "Card");
    const layers = await getAllLayers({ db, projectId });
    const layerId = resolveLayerRef(layers, requestedLayer);

    if (!(await reassignCardsToLayer({ db, projectId, cardIds: [cardId], layerId })).ok)
      throw new Error("Card and layer do not belong to the same project.");

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

export async function cardGlue(
  requestedIds: string[],
  options: CardGlueOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const {
      cards,
      cardIds: requestedCardIds,
      projectId,
    } = await resolveCardGroup(db, requestedIds);
    if (requestedCardIds.some((cardId) => findById(cards, cardId, "Card").projectId !== projectId))
      throw new Error("Cards must belong to the same project.");

    let cardIds = requestedCardIds;
    if (options.add) {
      const rels = await getGlueRelsByProject({ db, projectId });
      const glueIdByCardId = new Map(rels.map((rel) => [rel.cardId, rel.glueId]));
      const membersByGlueId = new Map<string, string[]>();
      for (const card of cards) {
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

    const result = await glueProjectCards({ db, projectId, cardIds });
    if (!result.ok) throw new Error("Cards must belong to the same project.");

    if (options.alignList) {
      const ui = getUiConfigForRoot(root);
      const bounds = canvasBoundsForRoot(root);
      const byId = new Map(cards.map((card) => [card.id, card]));
      const anchor = findById(cards, cardIds[0], "Card");
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
      const moved = await updateProjectCardPositions({ db, projectId, positions });
      if (!moved.ok) throw new Error("Cards must belong to the same project.");
    }

    const allCardIds = cards.map(({ id }) => id);
    console.log(`${cardIds.length} cards glued.`);
    if (options.add) console.log("  mode: additive");
    if (options.alignList) console.log("  layout: vertical list");
    console.log(`  glue: ${shortId(result.glueId, [result.glueId])}`);
    for (const cardId of cardIds) console.log(`  card: ${shortId(cardId, allCardIds)}`);
  });
}

export async function cardUnglue(requestedIds: string[]): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const { cards, cardIds, projectId } = await resolveCardGroup(db, requestedIds);
    const result = await unglueProjectCards({ db, projectId, cardIds });
    if (!result.ok) throw new Error("Cards must belong to the same project.");
    const allCardIds = cards.map(({ id }) => id);
    console.log(`${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} unglued.`);
    for (const cardId of cardIds) console.log(`  card: ${shortId(cardId, allCardIds)}`);
  });
}

/**
 * The three lines `--times` puts above the text, printed through the same {@link sortColumn}
 * `card list --sort` prints its column with, so one card reads the same whichever command
 * showed it — the unreadable timestamps of a hand-edited row included.
 *
 * `gap` is derived from the two above it rather than stored, and is listed all the same:
 * it is what `--sort gap` orders by, and a card is easier to find in that listing when the
 * command that shows one card names the same three things.
 *
 * The label column is measured from the keys rather than written down beside them, so a
 * fourth order stays one entry in `CARD_SORT_KEYS` and does not also have to be a number
 * corrected here.
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
    // Ids alone: resolving a short id needs every id in the workspace, but printing one
    // card needs one card's text. Selected together, `kozane card show` read the whole
    // content column — every card of every project — to put a single card on stdout.
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
    // Not `findById`: the row is fetched by a second query rather than found in the list
    // the id was resolved against, which is the case its docstring warns a `!` would break.
    if (!card) throw new Error(`Card not found: ${requestedId}`);
    // Behind a flag, and above the text rather than below it. Without the flag this command
    // prints a card's text and nothing else, which is what makes `kozane card show x > f.txt`
    // write the card — a history printed by default would end up in the file too.
    if (options.times) printCardTimes(card);
    console.log(card.content);
  });
}

export async function cardNearest(requestedId: string): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    // Positions first, without the text. Resolving a short id needs every card in the
    // workspace, but only the origin's own project is ever printed — carrying `content`
    // through this pass read every other project's cards to throw them away again.
    const placed = await db
      .select({
        id: cardTable.id,
        projectId: bundleTable.projectId,
        posX: cardTable.posX,
        posY: cardTable.posY,
      })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id));
    const cardId = resolveShortId(
      requestedId,
      placed.map(({ id }) => id),
      "Card",
    );
    const origin = findById(placed, cardId, "Card");

    // Now the text, for the one project that is about to be printed.
    const cards = await db
      .select({
        id: cardTable.id,
        bundle: bundleTable.name,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
      })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
      .where(eq(bundleTable.projectId, origin.projectId));
    // Equal distances are broken by `compareIds`, which is what `sortCards` breaks equal
    // timestamps with and `orderLayers` equal positions: the reason it is not
    // `localeCompare` is written once, in `lib/order.ts`.
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
  // Ahead of `runWorkspaceCommand`, because these two say nothing about the workspace:
  // `kozane card list --reverse` run outside one is a malformed command wherever it was
  // typed, and should say so rather than report the missing workspace it never got to.
  //
  // Thrown, not exited on: commander does not await this action, so nothing here catches a
  // rejection by itself — the `.catch(fail)` on the action in `index.ts` is what turns
  // these into the one-line `Error: ...` and the exit code every other refusal from this
  // file prints. That keeps the exit in the CLI's outermost layer and leaves this function
  // callable — and its refusals assertable — without ending the process.
  const { sort, reverse } = options;
  if (options.taskspace && (options.project || options.bundle))
    throw new Error("--taskspace cannot be combined with --project or --bundle.");
  // Without a key there is no order to reverse: the unsorted listing comes back in
  // whatever order SQLite hands the rows over, which is not an order anything promises.
  if (reverse && !sort) throw new Error("--reverse requires --sort.");

  // Both applied on every path below, so listing from a taskspace directory sorts the same
  // way — and prints the same column — as listing a project does.
  const ordered = <T extends ListedCard>(cards: T[]): T[] =>
    sort ? sortCards(cards, sort, reverse) : cards;
  const timeColumn = sort ? (card: CardTimes) => sortColumn(card, sort) : undefined;

  await runWorkspaceCommand(async ({ db }) => {
    const locatedMarker =
      options.taskspace || (!options.project && !options.bundle)
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
        const scopedCards = await getCardsByScopeWithBundleName({
          db,
          scopeId: taskspace.scopeId,
        });
        await printCards(
          db,
          ordered(scopedCards.map((card) => ({ ...card, bundle: card.bundleName }))),
          timeColumn,
        );
      } else {
        console.warn(
          "Notice: Taskspace is not attached to a scope. The scope may have been deleted.",
        );
        const taskspaceCards = await db
          .select({
            id: cardTable.id,
            bundle: bundleTable.name,
            content: cardTable.content,
            posX: cardTable.posX,
            posY: cardTable.posY,
            createdAt: cardTable.createdAt,
            updatedAt: cardTable.updatedAt,
          })
          .from(cardTable)
          .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
          .where(eq(cardTable.taskspaceId, taskspace.id));
        await printCards(db, ordered(taskspaceCards), timeColumn);
      }
      return;
    }

    const projectId = await resolveProjectId(db, options.project);
    const conditions = [eq(bundleTable.projectId, projectId)];
    if (options.bundle) {
      const bundleId = await resolveBundleId(db, projectId, options.bundle);
      conditions.push(eq(bundleTable.id, bundleId));
    }
    const cards = await db
      .select({
        id: cardTable.id,
        bundle: bundleTable.name,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
        createdAt: cardTable.createdAt,
        updatedAt: cardTable.updatedAt,
      })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
      .where(and(...conditions));
    await printCards(db, ordered(cards), timeColumn);
  });
}
