/** `kozane card glue` and `kozane card unglue`. */
import { runWorkspaceCommand } from "../../lib/workspace-command.js";
import { updateNamespaceCardPositions } from "../../../db/api/card.js";
import {
  getGlueRelsByNamespace,
  glueNamespaceCards,
  unglueNamespaceCards,
} from "../../../db/api/glue.js";
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
    if (!result.ok)
      throw new Error(
        result.reason === "stored-cards"
          ? "Stored cards cannot be glued. Take them out of their inventory first."
          : "Cards must belong to the same namespace.",
      );

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
