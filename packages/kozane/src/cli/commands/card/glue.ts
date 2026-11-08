/** `kozane card glue` and `kozane card unglue`. */
import { runWorkspaceCommand } from "../../lib/workspace-command.js";
import { updatePositionsInTx } from "../../../services/cards.js";
import { createInTx, removeInTx } from "../../../services/glues.js";
import { createServiceContext } from "../../../services/context.js";
import { composeWrite } from "../../../db/database.js";
import { ValidationError } from "../../../services/errors.js";
import { getGlueRelsByNamespace } from "../../../db/api/glue.js";
import { findById, shortId } from "../../lib/short-id.js";
import { loadCards, resolveCardGroup } from "../../lib/card-refs.js";
import { canvasBoundsForRoot, clampToBounds } from "../../../lib/server/canvas.js";
import { getUiConfigForRoot } from "../../../db/internal/config.js";
import { estimateCardHeight } from "../../../lib/warp-list.js";
import { GRID, type CardGlueOptions } from "./options.js";

export async function cardGlue(
  requestedIds: string[],
  options: CardGlueOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const context = createServiceContext(getUiConfigForRoot(root));
    const { cardIds, allIds, result } = await composeWrite(db, async (tx) => {
      const {
        index,
        allIds,
        cardIds: requestedCardIds,
        namespaceId,
      } = await resolveCardGroup(tx, requestedIds);
      if (
        requestedCardIds.some(
          (cardId) => findById(index, cardId, "Card").namespaceId !== namespaceId,
        )
      )
        throw new Error("Cards must belong to the same namespace.");

      let cardIds = requestedCardIds;
      if (options.add) {
        const rels = await getGlueRelsByNamespace({ db: tx, namespaceId });
        const glueIdByCardId = new Map(rels.map((rel) => [rel.cardId, rel.glueId]));
        // Build groups from the workspace index to preserve card order when choosing anchors and
        // printing members.
        const membersByGlueId = new Map<string, string[]>();
        for (const card of index) {
          const glueId = glueIdByCardId.get(card.id);
          if (glueId)
            membersByGlueId.set(glueId, [...(membersByGlueId.get(glueId) ?? []), card.id]);
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

      let result;
      try {
        result = await createInTx(tx, context, namespaceId, { cardIds });
      } catch (error) {
        if (error instanceof ValidationError)
          throw new Error(
            error.message === "Stored cards cannot be glued"
              ? "Stored cards cannot be glued. Take them out of their inventory first."
              : "Cards must belong to the same namespace.",
            { cause: error },
          );
        throw error;
      }
      if (options.alignList) {
        const ui = getUiConfigForRoot(root);
        const bounds = canvasBoundsForRoot(root);
        // Read text and width only for this branch, after `--add` has determined the expanded
        // card set.
        const detailed = await loadCards(tx, cardIds);
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
        await updatePositionsInTx(tx, context, namespaceId, { positions });
      }

      return { cardIds, allIds, result };
    });
    console.log(`${cardIds.length} cards glued.`);
    if (options.add) console.log("  mode: additive");
    if (options.alignList) console.log("  layout: vertical list");
    console.log(`  glue: ${shortId(result.glueId, [result.glueId])}`);
    for (const cardId of cardIds) console.log(`  card: ${shortId(cardId, allIds)}`);
  });
}

export async function cardUnglue(requestedIds: string[]): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const context = createServiceContext(getUiConfigForRoot(root));
    const { allIds, cardIds } = await composeWrite(db, async (tx) => {
      const { allIds, cardIds, namespaceId } = await resolveCardGroup(tx, requestedIds);
      try {
        await removeInTx(tx, context, namespaceId, { cardIds });
      } catch (error) {
        if (error instanceof ValidationError)
          throw new Error("Cards must belong to the same namespace.", { cause: error });
        throw error;
      }
      return { allIds, cardIds };
    });
    console.log(`${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} unglued.`);
    for (const cardId of cardIds) console.log(`  card: ${shortId(cardId, allIds)}`);
  });
}
