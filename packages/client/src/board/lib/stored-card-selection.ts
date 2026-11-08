import type { SelectionState } from "../namespace-state.svelte.js";

/**
 * Select a stored card the way a click selects a canvas one, so the composer's actions reach
 * it. A stored card has no glue group, so it is selected alone. Shift toggles it, and a plain
 * click selects only it, or clears the selection when it alone is already selected.
 */
export function selectStoredCard(selection: SelectionState, e: MouseEvent, cardId: string): void {
  if (selection.composerCard && selection.composerCard.id !== cardId) selection.composerCard = null;
  if (e.shiftKey) {
    const next = new Set(selection.selectedCards);
    if (!next.delete(cardId)) next.add(cardId);
    selection.selectedCards = next;
    return;
  }
  const onlyThis = selection.selectedCards.size === 1 && selection.selectedCards.has(cardId);
  selection.selectedCards = onlyThis ? new Set() : new Set([cardId]);
  selection.primarySelectedId = onlyThis ? null : cardId;
}
