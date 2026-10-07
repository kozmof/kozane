import type { BoardRect } from "$lib/constants";
import type { NamespaceState } from "../namespace-state.svelte.js";
import type { BoardPoint } from "./canvas-viewport.js";
import type { CardPositionPatch } from "./namespace-page.js";
import { maxZIndex } from "./namespace-page.js";
import {
  createCard,
  failureMessage,
  moveScopeArea,
  moveWarp,
  parseCard,
  parseScopeArea,
  parseWarp,
  patchCardPositions,
  updateCard,
} from "./namespace-api.js";

/**
 * Persist optimistic canvas and composer edits and report success for rollback handling.
 * Apply returned rows to local state so server-clamped values appear immediately.
 */
export function createBoardPersistence(s: NamespaceState) {
  async function persistPositions(positions: CardPositionPatch[]): Promise<boolean> {
    const res = await patchCardPositions(s.mutationFetcher, s.namespaceId, positions);
    return res.ok;
  }

  async function persistWidth(cardId: string, width: number): Promise<boolean> {
    const res = await updateCard(s.mutationFetcher, s.namespaceId, cardId, { width });
    return res.ok;
  }

  async function persistWarpPosition(warpId: string, position: BoardPoint): Promise<boolean> {
    const res = await moveWarp(s.mutationFetcher, s.namespaceId, warpId, position);
    if (!res.ok) return false;
    const stored = parseWarp(await res.json().catch(() => null));
    if (stored) s.warps = s.warps.map((w) => (w.id === warpId ? stored : w));
    return true;
  }

  async function persistScopeArea(
    scopeId: string,
    areaId: string,
    rect: BoardRect,
  ): Promise<boolean> {
    const res = await moveScopeArea(s.mutationFetcher, s.namespaceId, scopeId, areaId, rect);
    if (!res.ok) return false;
    const stored = parseScopeArea(await res.json().catch(() => null));
    // Persist the dragged frame by area ID because a scope may have multiple frames. Use its
    // stored rectangle for card membership.
    if (stored) s.scopeAreas = s.scopeAreas.map((a) => (a.id === areaId ? stored : a));
    return true;
  }

  /**
   * Save an existing card or create one at `placeNew` when no ID is supplied. Preserve server
   * error messages so the composer can explain validation failures.
   */
  async function submitComposer(
    id: string | null,
    content: string,
    partitionId: string,
    placeNew: () => BoardPoint,
  ): Promise<void> {
    if (id) {
      const res = await updateCard(s.mutationFetcher, s.namespaceId, id, { content, partitionId });
      if (!res.ok) {
        s.setError(await failureMessage(res, "Failed to save card"));
        return;
      }
      s.cards = s.cards.map((c) => (c.id === id ? { ...c, content, partitionId } : c));
      s.selection.composerCard = null;
      return;
    }

    const { posX, posY } = placeNew();
    const scopeId = s.sidebar.activeScope;
    const layerId = s.activeLayerId;
    // Only cards on the same layer compete for stacking, so the new card starts above them.
    const zIndex = maxZIndex(s.cards.filter((c) => c.layerId === layerId)) + 1;
    const res = await createCard(s.mutationFetcher, s.namespaceId, {
      partitionId,
      content,
      posX,
      posY,
      zIndex,
      ...(scopeId && { scopeId }),
      ...(layerId && { layerId }),
    });
    if (!res.ok) {
      s.setError(await failureMessage(res, "Failed to create card"));
      return;
    }
    // Validate the returned card and use its stored coordinates because the server clamps
    // positions. See `parseCard`.
    const created = parseCard(await res.json().catch(() => null));
    if (!created) {
      s.setError("Failed to create card");
      return;
    }
    s.cards = [...s.cards, created];
    if (scopeId) s.scopeRels = [...s.scopeRels, { scopeId, cardId: created.id }];
  }

  return { persistPositions, persistWidth, persistWarpPosition, persistScopeArea, submitComposer };
}
