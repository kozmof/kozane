import type { NamespaceState } from "../namespace-state.svelte.js";
import type { KozaneClient } from "../../backend/contract.js";
import { ClientError } from "../../backend/contract.js";
import { readCard, readWarp, readScopeArea } from "../../backend/decoders/snapshot-reader.js";
import { readPlacements } from "../../backend/decoders/placements.js";
import type { BoardRect } from "../../constants/index.js";
import type { BoardPoint } from "./canvas-viewport.js";
import type { CardPositionPatch } from "./namespace-page.js";
import type { CardWithGlue } from "@kozane/core";

/** Optimistic UI persistence through transport-free resource methods. */
export function createClientBoardPersistence(
  s: NamespaceState,
  backend: Pick<KozaneClient, "cards" | "warps" | "scopes">,
) {
  const placements = (cards: CardWithGlue[], value: unknown) => {
    const changes = new Map((readPlacements(value) ?? []).map((row) => [row.cardId, row]));
    return cards.map((card) => {
      const placed = changes.get(card.id);
      return placed ? { ...card, inventory: { id: placed.inventoryId, slot: placed.slot } } : card;
    });
  };
  async function persistPositions(positions: CardPositionPatch[]): Promise<boolean> {
    try {
      return await s.mutations.track(async () => {
        await backend.cards.updatePositions(s.namespaceId, { positions });
        return true;
      });
    } catch {
      return false;
    }
  }
  async function persistWidth(cardId: string, width: number): Promise<boolean> {
    try {
      return await s.mutations.track(async () => {
        await backend.cards.update(s.namespaceId, cardId, { width });
        return true;
      });
    } catch {
      return false;
    }
  }
  async function persistWarpPosition(id: string, position: BoardPoint): Promise<boolean> {
    try {
      return await s.mutations.track(async () => {
        const stored = readWarp(await backend.warps.update(s.namespaceId, id, position));
        if (stored) s.warps = s.warps.map((warp) => (warp.id === id ? stored : warp));
        return true;
      });
    } catch {
      return false;
    }
  }
  async function persistScopeArea(
    scopeId: string,
    areaId: string,
    rect: BoardRect,
  ): Promise<boolean> {
    try {
      return await s.mutations.track(async () => {
        const stored = readScopeArea(
          await backend.scopes.updateArea(s.namespaceId, scopeId, areaId, { ...rect }),
        );
        if (stored) s.scopeAreas = s.scopeAreas.map((area) => (area.id === areaId ? stored : area));
        return true;
      });
    } catch {
      return false;
    }
  }
  async function submitComposer(
    id: string | null,
    content: string,
    partitionId: string,
    placeNew: () => BoardPoint,
  ): Promise<void> {
    await s.mutations.track(async () => {
      try {
        if (id) {
          const body = await backend.cards.update(s.namespaceId, id, { content, partitionId });
          const stored = typeof body.content === "string" ? body.content : content.trim();
          s.cards = placements(s.cards, body).map((card) =>
            card.id === id ? { ...card, content: stored, partitionId } : card,
          );
          s.selection.composerCard = null;
          return;
        }
        const scopeId = s.sidebar.activeScope,
          layerId = s.activeLayerId,
          inventoryId = s.receivingInventoryId;
        const body = await backend.cards.create(s.namespaceId, {
          partitionId,
          content,
          ...placeNew(),
          ...(scopeId ? { scopeId } : {}),
          ...(layerId ? { layerId } : {}),
          ...(inventoryId ? { inventoryId } : {}),
        });
        const created = readCard(body);
        if (!created) {
          s.setError("Failed to create card");
          return;
        }
        s.cards = [...placements(s.cards, body).filter((card) => card.id !== created.id), created];
        if (
          scopeId &&
          !s.scopeRels.some((rel) => rel.scopeId === scopeId && rel.cardId === created.id)
        )
          s.scopeRels = [...s.scopeRels, { scopeId, cardId: created.id }];
      } catch (error) {
        s.setError(
          error instanceof ClientError
            ? error.message
            : id
              ? "Failed to save card"
              : "Failed to create card",
        );
      }
    });
  }
  return { persistPositions, persistWidth, persistWarpPosition, persistScopeArea, submitComposer };
}
