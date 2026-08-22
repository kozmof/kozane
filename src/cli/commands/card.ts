import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { requireWorkspace } from "../lib/project.js";
import { commandDbUrl } from "../lib/config.js";
import { createDb } from "../../db/client.js";
import { bundleTable, cardTable, projectTable, scopeTable } from "../../db/schema.js";
import { addCard, addCards, reassignCardsToLayer } from "../../db/api/card.js";
import { getDefaultBundle } from "../../db/api/bundle.js";
import { getAllLayers } from "../../db/api/layer.js";
import {
  addScopeRel,
  addScopeRels,
  getCardsByScopeWithBundleName,
} from "../../db/api/scope-rel.js";
import { getTaskspace } from "../../db/api/taskspace.js";
import { findById, resolveShortId, shortId, shortIdMap } from "../lib/short-id.js";
import { resolveLayerRef } from "../lib/layer-ref.js";
import { readTaskspaceMarker } from "../lib/taskspace-marker.js";
import { withTx, type DB } from "../../db/tx.js";
import { splitCardContent, squashCardPositions } from "../../lib/squash.js";
import { resolveProjectId } from "../lib/project-selection.js";
import { contentLimitIssue } from "../../lib/constants.js";
import { canvasBoundsForRoot, clampToBounds } from "../../lib/server/canvas.js";
import { contentMaxForRoot } from "../../lib/server/content-limit.js";

type CardOptions = { project?: string; bundle?: string; taskspace?: string };
type CardAddOptions = Omit<CardOptions, "taskspace"> & {
  scope?: string;
  layer?: string;
  x?: number;
  y?: number;
};
type CardSquashOptions = Omit<CardAddOptions, "x" | "y"> & { pattern?: string };

type ListedCard = {
  id: string;
  bundle: string;
  content: string;
  posX: number;
  posY: number;
};
type DistanceListedCard = ListedCard & { distance: number };

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

function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/** Prints one line per card, adding a distance column when the cards carry one. */
async function printCards(db: DB, cards: (ListedCard | DistanceListedCard)[]): Promise<void> {
  if (cards.length === 0) {
    console.log("No cards found.");
    return;
  }
  const allCards = await db.select({ id: cardTable.id }).from(cardTable);
  const shortIds = shortIdMap(allCards.map(({ id }) => id));
  for (const card of cards) {
    const distance = "distance" in card ? `${card.distance.toFixed(2)}  ` : "";
    console.log(
      `${shortIds.get(card.id) ?? card.id}  ${card.bundle}  (${card.posX}, ${card.posY})  ${distance}${card.content.replace(/\r?\n/g, " ")}`,
    );
  }
}

export async function cardAdd(content: string, options: CardAddOptions = {}): Promise<void> {
  try {
    const { root } = requireWorkspace();
    // After the workspace, not before: the limit is `ui.contentMax` of this workspace, so
    // there is nothing to hold the text against until one has been found.
    const contentIssue = contentLimitIssue(content, contentMaxForRoot(resolve(root)));
    if (contentIssue) throw new Error(contentIssue);

    const db = await createDb(commandDbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const bundleId = await resolveBundleId(db, projectId, options.bundle);
    const layerId = await resolveLayerId(db, projectId, options.layer);
    const scopeId = options.scope ? await resolveScopeId(db, options.scope) : undefined;
    // `--x`/`--y` are held to the board the same way the create endpoint holds a dragged
    // card, and against the same workspace bounds: a position outside them is one the
    // viewport can never scroll to, so a card stored there is a card nobody can find.
    const placement = clampToBounds(
      options.x ?? 0,
      options.y ?? 0,
      canvasBoundsForRoot(resolve(root)),
    );
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
  } catch (error) {
    fail(error);
  }
}

export async function cardSquash(
  content: string | undefined,
  options: CardSquashOptions = {},
): Promise<void> {
  try {
    const contents = splitCardContent(content ?? readFileSync(0, "utf8"), options.pattern);
    if (contents.length === 0) throw new Error("Content must contain at least one non-empty card.");

    const { root } = requireWorkspace();
    // Each segment becomes a card of its own, so each is held to the limit a card is held
    // to — this workspace's `ui.contentMax`, which is why this waits for the workspace.
    // Reported by position, the only thing that tells one segment of a piped file from
    // another, and checked before anything is written so a refusal leaves the board alone.
    const limit = contentMaxForRoot(resolve(root));
    for (const [index, segment] of contents.entries()) {
      const issue = contentLimitIssue(segment, limit);
      if (issue) throw new Error(`Card ${index + 1} of ${contents.length}: ${issue}`);
    }

    const db = await createDb(commandDbUrl(resolve(root)));
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
    const bounds = canvasBoundsForRoot(resolve(root));
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
  } catch (error) {
    fail(error);
  }
}

/**
 * Moves an existing card to another layer of its own project. The project is taken from
 * the card rather than from `--project`, so the layer is always resolved against the
 * project that actually owns the card.
 */
export async function cardSetLayer(requestedCardId: string, requestedLayer: string): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
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
  } catch (error) {
    fail(error);
  }
}

export async function cardShow(requestedId: string): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const cards = await db.select({ id: cardTable.id, content: cardTable.content }).from(cardTable);
    const cardId = resolveShortId(
      requestedId,
      cards.map(({ id }) => id),
      "Card",
    );
    const card = findById(cards, cardId, "Card");
    console.log(card.content);
  } catch (error) {
    fail(error);
  }
}

export async function cardNearest(requestedId: string): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const cards = await db
      .select({
        id: cardTable.id,
        projectId: bundleTable.projectId,
        bundle: bundleTable.name,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
      })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id));
    const cardId = resolveShortId(
      requestedId,
      cards.map(({ id }) => id),
      "Card",
    );
    const origin = findById(cards, cardId, "Card");
    const sorted = cards
      .filter(({ projectId }) => projectId === origin.projectId)
      .map((card) => ({
        ...card,
        distance: Math.hypot(card.posX - origin.posX, card.posY - origin.posY),
      }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    await printCards(db, sorted);
  } catch (error) {
    fail(error);
  }
}

export async function cardList(options: CardOptions = {}): Promise<void> {
  try {
    if (options.taskspace && (options.project || options.bundle))
      throw new Error("--taskspace cannot be combined with --project or --bundle.");

    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
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
          scopedCards.map((card) => ({ ...card, bundle: card.bundleName })),
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
          })
          .from(cardTable)
          .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
          .where(eq(cardTable.taskspaceId, taskspace.id));
        await printCards(db, taskspaceCards);
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
      })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
      .where(and(...conditions));
    await printCards(db, cards);
  } catch (error) {
    fail(error);
  }
}
