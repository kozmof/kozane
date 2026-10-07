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
 * The saves the board's canvas and composer hand to the page, against the namespace state.
 *
 * Split from `namespace-actions.svelte.ts` along the line the canvas draws: every save here
 * follows an edit the board has already made — a card dragged, a frame resized, a warp
 * dropped — and only answers whether it took, so the canvas can put the old value back if it
 * did not. The actions module is the other kind: it makes the edit and the request together.
 *
 * Where a save comes back with the stored row, the row is written back: the server clamps to
 * the canvas, so a thing dropped at the very edge would otherwise sit a few pixels off what
 * was kept until the next poll corrected it.
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
    // By id, not by scope: a scope may have several frames here, and the one that moved is
    // the one that was dragged. Every card it holds is filed against this rectangle, so it
    // has to be the stored one.
    if (stored) s.scopeAreas = s.scopeAreas.map((a) => (a.id === areaId ? stored : a));
    return true;
  }

  /**
   * Saves what the composer submitted: an edit to `id`, or a new card when `id` is null,
   * placed at whatever `placeNew` answers.
   *
   * Errors carry the server's own message rather than a fixed one: a refusal the composer
   * cannot foresee — text past `ui.contentMax` above all — is the reason the writer needs.
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
    // Read rather than trusted: a body missing `posX` would put this card at `undefined` on
    // the canvas. The stored row, not a local reconstruction, because the server clamps
    // posX/posY to the canvas. See `parseCard`.
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
