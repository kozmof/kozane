import type { ScopeRel } from "$lib/types";

/** How much of a selection a scope already holds. */
export type ScopeLink = "all" | "some" | "none";

/**
 * Report whether all, some, or none of the selected cards belong to the scope. An empty
 * selection returns none.
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
 * Count selected cards in `scopeId` from their relations. Avoid building an index of every
 * membership to answer for a small selection.
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
