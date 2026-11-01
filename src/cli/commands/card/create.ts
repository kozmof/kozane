/** `kozane card add` and `kozane card squash`. */
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { runWorkspaceCommand } from "../../lib/workspace-command.js";
import {
  partitionTable,
  cardTable,
  inventoryTable,
  namespaceTable,
  scopeTable,
} from "../../../db/schema.js";
import { addCardInTx, addCardsInTx, onCanvas } from "../../../db/api/card.js";
import { getAllLayers } from "../../../db/api/layer.js";
import { addScopeRel, addScopeRels } from "../../../db/api/scope-rel.js";
import { shortId, shortIdMap } from "../../lib/short-id.js";
import { resolvePartitionId, resolveLayerId, resolveScopeId } from "../../lib/card-refs.js";
import { withTx } from "../../../db/tx.js";
import { addSquashInventoryInTx } from "../../../db/api/inventory.js";
import {
  splitCardContent,
  squashCardPositions,
  squashInventorySlots,
} from "../../../lib/squash.js";
import { resolveNamespaceId } from "../../lib/namespace-selection.js";
import { checkCardContent, contentLimitIssue } from "../../../lib/constants.js";
import { canvasBoundsForRoot, clampToBounds } from "../../../lib/server/canvas.js";
import { contentMaxForRoot } from "../../../lib/server/content-limit.js";
import { type CardAddOptions, type CardSquashOptions } from "./options.js";

export async function cardAdd(rawContent: string, options: CardAddOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    // Validate against the workspace's `ui.contentMax` after loading its configuration, with
    // the same trimming and blank check the HTTP routes apply.
    const checked = checkCardContent(rawContent, contentMaxForRoot(root));
    if (!checked.ok) throw new Error(checked.issue);
    const { content } = checked;

    // Clamp `--x` and `--y` to the workspace's board bounds so the viewport can reach the card.
    const placement = clampToBounds(options.x ?? 0, options.y ?? 0, canvasBoundsForRoot(root));
    // Resolve inside the writing transaction, as the HTTP route does, so a partition, layer, or
    // scope deleted by another writer in between is reported as not found rather than as a
    // foreign-key failure.
    const { id, namespaceId, partitionId, layerId, scopeId } = await withTx(db, async (tx) => {
      const namespaceId = await resolveNamespaceId(tx, options.namespace);
      const partitionId = await resolvePartitionId(tx, namespaceId, options.partition);
      const layerId = await resolveLayerId(tx, namespaceId, options.layer);
      const scopeId = options.scope ? await resolveScopeId(tx, options.scope) : undefined;
      const cardId = await addCardInTx({
        db: tx,
        partitionId,
        layerId,
        content,
        ...placement,
      });
      if (scopeId) await addScopeRel({ db: tx, scopeId, cardId });
      return { id: cardId, namespaceId, partitionId, layerId, scopeId };
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

    const slots = squashInventorySlots(contents);
    if (!slots)
      throw new Error(
        `${contents.length} cards do not fit in one inventory. Split the text more coarsely.`,
      );

    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const partitionId = await resolvePartitionId(db, namespaceId, options.partition);
    const layerId = await resolveLayerId(db, namespaceId, options.layer);
    const scopeId = options.scope ? await resolveScopeId(db, options.scope) : undefined;
    const bounds = canvasBoundsForRoot(root);
    const origin = clampToBounds(options.x ?? 0, options.y ?? 0, bounds);
    const occupied = await db
      .select({ posX: cardTable.posX, posY: cardTable.posY })
      .from(cardTable)
      .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
      // A stored card's position is where it goes back to, not space it takes up now.
      .where(and(eq(partitionTable.namespaceId, namespaceId), onCanvas));
    // The cards go into a new inventory at the origin. Lay out the positions they go back to
    // from there, using the workspace's `ui.canvasWidth`, and clamp them to the board.
    // `squashNamespaceCard` uses the same steps.
    const positions = squashCardPositions(occupied, contents.length, {
      origin,
      canvasWidth: bounds.canvasWidth,
    });
    const { inventory, ids } = await withTx(db, async (tx) => {
      const inventory = await addSquashInventoryInTx({ db: tx, namespaceId, ...origin });
      const cardIds = await addCardsInTx({
        db: tx,
        partitionId,
        layerId,
        cards: contents.map((cardContent, index) => ({
          content: cardContent,
          ...clampToBounds(positions[index].posX, positions[index].posY, bounds),
          inventory: { id: inventory.id, slot: slots[index] },
        })),
      });
      if (scopeId) await addScopeRels({ db: tx, scopeId, cardIds });
      return { inventory, ids: cardIds };
    });

    const [allCards, allInventories] = await Promise.all([
      db.select({ id: cardTable.id }).from(cardTable),
      db.select({ id: inventoryTable.id }).from(inventoryTable),
    ]);
    const shortIds = shortIdMap(allCards.map(({ id }) => id));
    console.log(
      `${ids.length} ${ids.length === 1 ? "card" : "cards"} added to inventory "${inventory.name}".`,
    );
    console.log(
      `  inventory: ${shortId(
        inventory.id,
        allInventories.map(({ id }) => id),
      )}`,
    );
    for (const id of ids) console.log(`  ${shortIds.get(id) ?? id}`);
  });
}
