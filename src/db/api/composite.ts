import { withTx, type DB, type AnyDB } from "../tx.js";
import {
  addCard,
  reassignBundleCards,
  reassignLayerCards,
  cardsInProject,
  getCardBundleNames,
  getCardLayerNames,
} from "./card.js";
import { deleteBundle, getBundle, getDefaultBundle, getAllBundles, addBundle } from "./bundle.js";
import { deleteLayer, getLayer, getDefaultLayer, getAllLayers, addLayer } from "./layer.js";
import { addScopeRel, getScopeRelsByCards } from "./scope-rel.js";
import { getTaskspace } from "./taskspace.js";
import { unglueCardsInTx } from "./glue.js";
import { NotFoundError, DefaultBundleError, DefaultLayerError } from "./utils.js";
import { and, eq, inArray } from "drizzle-orm";
import { bundleTable, cardTable, scopeRelTable } from "../schema.js";
import type { Card } from "./types.js";
import { BATCH_MAX, INSERT_CHUNK_MAX, clamp } from "../../lib/constants.js";
import { splitCardContent, squashCardPositions } from "../../lib/squash.js";

type CreateCardFromTaskspace = {
  db: DB;
  taskspaceId: string;
  bundleId: string;
  content: string;
};

type CreateCardInTaskspaceContext = {
  db: AnyDB;
  taskspaceId: string;
  bundleId: string;
  content: string;
};

/**
 * Core logic for creating a card within a taskspace context.
 * Exported separately so it can be tested without a transaction.
 * Production callers should use `createCardFromTaskspace`, which wraps
 * this in a transaction to keep the card insert and scope_rel insert atomic.
 */
export async function createCardInTaskspaceContext({
  db,
  taskspaceId,
  bundleId,
  content,
}: CreateCardInTaskspaceContext): Promise<string> {
  const taskspace = await getTaskspace({ db, taskspaceId });
  if (!taskspace) throw new NotFoundError(`Taskspace taskspaceId=${taskspaceId}`);
  const cardId = await addCard({ db, bundleId, content, taskspaceId });
  if (taskspace.scopeId) {
    await addScopeRel({ db, scopeId: taskspace.scopeId, cardId });
  }
  return cardId;
}

/**
 * Creates a card in the given bundle within a taskspace context.
 * If the taskspace is still attached to a scope, the new card is
 * simultaneously registered in scope_rel (auto-add, 7-1), making the
 * "originated" and "gathered" relationships consistent from creation time.
 * Throws NotFoundError when taskspaceId does not exist.
 */
export async function createCardFromTaskspace({
  db,
  taskspaceId,
  bundleId,
  content,
}: CreateCardFromTaskspace): Promise<string> {
  return withTx(db, (tx) =>
    createCardInTaskspaceContext({ db: tx, taskspaceId, bundleId, content }),
  );
}

type DeleteProjectCards = { db: DB; projectId: string; cardIds: string[] };

/**
 * Deletes cards after verifying every one belongs to projectId, dissolving any glue
 * group the removal would leave degenerate. Returns false if any card is not owned.
 *
 * The unglue step is not optional: deleting a card cascades its glue_rel row away
 * without going through glue.ts, which would strand the surviving partner of a
 * two-card group in a group of one — a card the UI still offers to "unglue".
 */
export async function deleteProjectCards({
  db,
  projectId,
  cardIds,
}: DeleteProjectCards): Promise<boolean> {
  if (cardIds.length === 0) return true;
  const uniqueIds = [...new Set(cardIds)];
  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, projectId, uniqueIds);
    if (owned.length !== uniqueIds.length) return false;
    await unglueCardsInTx(tx, uniqueIds);
    await tx.delete(cardTable).where(inArray(cardTable.id, uniqueIds));
    return true;
  });
}

type SquashProjectCard = {
  db: DB;
  projectId: string;
  cardId: string;
  canvasWidth: number;
  canvasHeight: number;
};

export type SquashCardResult =
  | { ok: false; reason: "not-found" | "indivisible" | "too-many" }
  | { ok: true; cards: Card[] };

function chunked<T>(rows: T[], size = INSERT_CHUNK_MAX): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += size)
    chunks.push(rows.slice(start, start + size));
  return chunks;
}

/**
 * Replaces a card with one card per segment of its text, in the manner of
 * `kozane card squash`: the pieces inherit its bundle, layer, taskspace, width, and scope
 * memberships, are laid out from where it sat, and the card itself is removed. All in one
 * transaction, so a failure leaves the original whole rather than half of it on the board.
 *
 * Refuses a card whose text yields a single segment — squashing it would delete and
 * recreate the same card under a new id, breaking any reference to the old one for nothing.
 *
 * The source leaves its glue group on the way out, for the reason `deleteProjectCards`
 * gives. The pieces start unglued: they are one card's worth of text, not a group someone
 * arranged.
 */
export async function squashProjectCard({
  db,
  projectId,
  cardId,
  canvasWidth,
  canvasHeight,
}: SquashProjectCard): Promise<SquashCardResult> {
  return withTx(db, async (tx) => {
    const inProject = and(
      eq(cardTable.bundleId, bundleTable.id),
      eq(bundleTable.projectId, projectId),
    );
    const source = await tx
      .select({
        id: cardTable.id,
        bundleId: cardTable.bundleId,
        layerId: cardTable.layerId,
        taskspaceId: cardTable.taskspaceId,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
        zIndex: cardTable.zIndex,
        width: cardTable.width,
      })
      .from(cardTable)
      .innerJoin(bundleTable, inProject)
      .where(eq(cardTable.id, cardId))
      .get();
    if (!source) return { ok: false, reason: "not-found" };

    const contents = splitCardContent(source.content);
    if (contents.length < 2) return { ok: false, reason: "indivisible" };
    if (contents.length > BATCH_MAX) return { ok: false, reason: "too-many" };

    const occupied = await tx
      .select({ id: cardTable.id, posX: cardTable.posX, posY: cardTable.posY })
      .from(cardTable)
      .innerJoin(bundleTable, inProject);
    const positions = squashCardPositions(
      // Not the source's own slot: it is about to be deleted, so the first piece takes the
      // place the card the user was looking at had.
      occupied.filter(({ id }) => id !== cardId),
      contents.length,
      { origin: { posX: source.posX, posY: source.posY }, canvasWidth },
    );

    const cards: Card[] = [];
    const rows = contents.map((content, index) => ({
      bundleId: source.bundleId,
      layerId: source.layerId,
      taskspaceId: source.taskspaceId,
      content,
      // The layout runs off the board once the origin is near enough to an edge, and a
      // stored position outside it is one the viewport can never reach.
      posX: clamp(positions[index].posX, 0, canvasWidth),
      posY: clamp(positions[index].posY, 0, canvasHeight),
      // Above whatever the source sat above, and in the order the text reads.
      zIndex: source.zIndex + index,
      width: source.width,
    }));
    for (const batch of chunked(rows))
      cards.push(...(await tx.insert(cardTable).values(batch).returning()));

    // What the source was gathered into, the pieces are gathered into: a scope is a
    // working set, and splitting a card is not a decision to leave one.
    const scopeIds = (await getScopeRelsByCards({ db: tx, cardIds: [cardId] })).map(
      ({ scopeId }) => scopeId,
    );
    const scopeRels = scopeIds.flatMap((scopeId) =>
      cards.map(({ id }) => ({ scopeId, cardId: id })),
    );
    for (const batch of chunked(scopeRels))
      await tx.insert(scopeRelTable).values(batch).onConflictDoNothing();

    await unglueCardsInTx(tx, [cardId]);
    await tx.delete(cardTable).where(eq(cardTable.id, cardId));

    return { ok: true, cards };
  });
}

type MoveCardsToProject = {
  db: DB;
  sourceProjectId: string;
  targetProjectId: string;
  cardIds: string[];
};

type RemapCardsByName = {
  /** Each card paired with the name of the thing it currently belongs to. */
  current: { cardId: string; name: string }[];
  /** Candidates in the target project, matched against `current` by name. */
  targets: { id: string; name: string }[];
  create: (name: string) => Promise<string>;
  assign: (targetId: string, cardIds: string[]) => Promise<void>;
};

/**
 * Re-points cards at the same-named row in another project, creating it when the target
 * has none. Both of a card's owners — its bundle and its layer — are per-project ids that
 * cannot survive a move, and both are preserved this way.
 */
async function remapCardsByName({
  current,
  targets,
  create,
  assign,
}: RemapCardsByName): Promise<void> {
  // Resolved and grouped in one pass, so the id a card is filed under is the one just
  // looked up rather than a second lookup that has to be asserted non-empty.
  const targetIdByName = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const { cardId, name } of current) {
    let targetId = targetIdByName.get(name);
    if (targetId === undefined) {
      targetId = targets.find((target) => target.name === name)?.id ?? (await create(name));
      targetIdByName.set(name, targetId);
    }
    const group = groups.get(targetId) ?? [];
    group.push(cardId);
    groups.set(targetId, group);
  }

  for (const [targetId, ids] of groups) await assign(targetId, ids);
}

/**
 * Moves cards from one project to another, preserving bundle and layer names.
 * For each unique source name, a matching bundle/layer is found in the target
 * project or created if absent. All updates are atomic.
 * Returns false if any card does not belong to sourceProjectId.
 */
export async function moveCardsToProject({
  db,
  sourceProjectId,
  targetProjectId,
  cardIds,
}: MoveCardsToProject): Promise<boolean> {
  if (cardIds.length === 0) return true;
  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, sourceProjectId, cardIds);
    if (owned.length !== cardIds.length) return false;

    const cardBundles = await getCardBundleNames({ db: tx, cardIds });
    await remapCardsByName({
      current: cardBundles.map(({ cardId, bundleName }) => ({ cardId, name: bundleName })),
      targets: await getAllBundles({ db: tx, projectId: targetProjectId }),
      create: (name) => addBundle({ db: tx, projectId: targetProjectId, name }),
      assign: async (bundleId, ids) => {
        await tx.update(cardTable).set({ bundleId }).where(inArray(cardTable.id, ids));
      },
    });

    const cardLayers = await getCardLayerNames({ db: tx, cardIds });
    await remapCardsByName({
      current: cardLayers.map(({ cardId, layerName }) => ({ cardId, name: layerName })),
      targets: await getAllLayers({ db: tx, projectId: targetProjectId }),
      create: async (name) => (await addLayer({ db: tx, projectId: targetProjectId, name })).id,
      assign: async (layerId, ids) => {
        await tx.update(cardTable).set({ layerId }).where(inArray(cardTable.id, ids));
      },
    });

    // Cards moved cross-project must leave their glue groups: a glue group
    // spanning two projects is never visible in the UI and leaves stale rows.
    await unglueCardsInTx(tx, cardIds);

    return true;
  });
}

type DeleteBundleWithReassign = { db: DB; projectId: string; bundleId: string };

/**
 * Deletes a non-default bundle and reassigns its cards to the project's default
 * bundle, atomically. Throws NotFoundError if the bundle doesn't exist.
 */
export async function deleteBundleWithReassign({
  db,
  projectId,
  bundleId,
}: DeleteBundleWithReassign): Promise<{ defaultBundleId: string }> {
  return withTx(db, async (tx) => {
    const bundle = await getBundle({ db: tx, projectId, bundleId });
    if (!bundle) throw new NotFoundError(`Bundle projectId=${projectId} bundleId=${bundleId}`);
    if (bundle.isDefault) throw new DefaultBundleError();

    const defaultBundle = await getDefaultBundle({ db: tx, projectId });
    if (!defaultBundle) throw new Error("No default bundle found for this project");

    await reassignBundleCards({ db: tx, fromBundleId: bundleId, toBundleId: defaultBundle.id });
    await deleteBundle({ db: tx, projectId, bundleId });

    return { defaultBundleId: defaultBundle.id };
  });
}

type DeleteLayerWithReassign = { db: DB; projectId: string; layerId: string };

/**
 * Deletes a non-default layer and moves its cards to the project's default layer,
 * atomically. Without the reassign, deleting a layer would cascade its cards away.
 * Throws NotFoundError if the layer doesn't exist, DefaultLayerError for the default one.
 */
export async function deleteLayerWithReassign({
  db,
  projectId,
  layerId,
}: DeleteLayerWithReassign): Promise<{ defaultLayerId: string }> {
  return withTx(db, async (tx) => {
    const layer = await getLayer({ db: tx, projectId, layerId });
    if (!layer) throw new NotFoundError(`Layer projectId=${projectId} layerId=${layerId}`);
    if (layer.isDefault) throw new DefaultLayerError();

    const defaultLayer = await getDefaultLayer({ db: tx, projectId });
    if (!defaultLayer) throw new Error("No default layer found for this project");

    await reassignLayerCards({ db: tx, fromLayerId: layerId, toLayerId: defaultLayer.id });
    await deleteLayer({ db: tx, projectId, layerId });

    return { defaultLayerId: defaultLayer.id };
  });
}
