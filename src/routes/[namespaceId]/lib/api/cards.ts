/** Card requests: create, edit, delete, glue, and batch moves. */
import type { CardPositionPatch } from "../../../../../packages/client/src/board/lib/namespace-page.js";
import type { CardWithGlue } from "$lib/types.js";
import { readArray } from "../../../../../packages/client/src/board/lib/response.js";
import { readCard } from "../snapshot-reader.js";
import { apiUrl, jsonRequest } from "./request.js";

export function patchCardPositions(
  fetcher: typeof fetch,
  namespaceId: string,
  positions: CardPositionPatch[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards"), "PATCH", { positions });
}

export function createCard(
  fetcher: typeof fetch,
  namespaceId: string,
  card: {
    partitionId: string;
    content: string;
    posX: number;
    posY: number;
    zIndex?: number;
    scopeId?: string;
    layerId?: string;
    /** Stores the new card in this inventory's first free slot instead of on the canvas. */
    inventoryId?: string;
  },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards"), "POST", card);
}

export function updateCard(
  fetcher: typeof fetch,
  namespaceId: string,
  cardId: string,
  card: {
    content?: string;
    partitionId?: string;
    layerId?: string;
    zIndex?: number;
    /** Null clears the pinned width and restores `ui.defaultCardWidth`. */
    width?: number | null;
  },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/cards/${cardId}`), "PATCH", card);
}

export function deleteCard(
  fetcher: typeof fetch,
  namespaceId: string,
  cardId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/cards/${cardId}`), "DELETE");
}

/**
 * Replace one card with a card per text segment. The server chooses the split pattern.
 * The request sends no split options.
 */
export function squashCard(
  fetcher: typeof fetch,
  namespaceId: string,
  cardId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/squash"), "POST", { cardId });
}

/**
 * Validate a created card through {@link readCard}, returning null for an invalid response.
 * Use the stored row so clamped coordinates reach the board.
 */
export function parseCard(value: unknown): CardWithGlue | null {
  return readCard(value) ?? null;
}

/**
 * Validate every card in a nonempty squash response. Reject the whole result if any element
 * is invalid because partial replacement would lose part of the source card.
 */
export function parseCards(value: unknown): CardWithGlue[] | null {
  const rows = readArray(value, "cards");
  if (!rows || rows.length === 0) return null;
  const cards: CardWithGlue[] = [];
  for (const row of rows) {
    const card = readCard(row);
    if (!card) return null;
    cards.push(card);
  }
  return cards;
}

export function deleteCards(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards"), "DELETE", { cardIds });
}

export function glueCards(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/glues"), "POST", { cardIds });
}

export function unglueCards(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/glues"), "DELETE", { cardIds });
}

export function batchReassignPartition(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
  partitionId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/partition"), "PATCH", {
    cardIds,
    partitionId,
  });
}

export function batchReassignLayer(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
  layerId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/layer"), "PATCH", { cardIds, layerId });
}

export function batchChangeStackOrder(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
  direction: "front" | "back",
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/stacking"), "PATCH", {
    cardIds,
    direction,
  });
}

export function moveCardsToNamespace(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
  targetNamespaceId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/move"), "POST", {
    cardIds,
    targetNamespaceId,
  });
}
