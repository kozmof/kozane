import type { ScopeRel } from "$lib/types";

/** How much of a selection a scope already holds. */
export type ScopeLink = "all" | "some" | "none";

/**
 * Whether every selected card is in `scopeId`, only some of them, or none.
 *
 * The sidebar has computed the all-or-nothing half of this inline since scopes gained a
 * membership button, and the file palette needs the same answer with the middle case drawn
 * rather than rounded down — a row reading "Link" over a selection half of which is already
 * there says nothing about what the click will do. One predicate for both, so the panel and
 * the palette cannot come to disagree about what "linked" means.
 *
 * An empty selection is `"none"`: there is nothing to be in the scope, and the callers use
 * this only where something is selected.
 */
export function scopeLinkState(
  scopeRels: ScopeRel[],
  scopeId: string,
  selectedCards: Set<string>,
): ScopeLink {
  if (selectedCards.size === 0) return "none";
  const linked = countLinked(scopeRels, scopeId, selectedCards);
  if (linked === 0) return "none";
  return linked === selectedCards.size ? "all" : "some";
}

/**
 * How many of the selected cards are in `scopeId`.
 *
 * Counted from the relations rather than from a per-scope set built up front: a board holds
 * one row per card per scope, and the palette asks this once per scope against a selection
 * of a handful, which is cheaper than indexing every relation to answer for the few scopes
 * actually on screen.
 */
export function countLinked(
  scopeRels: ScopeRel[],
  scopeId: string,
  selectedCards: Set<string>,
): number {
  let linked = 0;
  for (const rel of scopeRels) {
    if (rel.scopeId === scopeId && selectedCards.has(rel.cardId)) linked++;
  }
  return linked;
}
