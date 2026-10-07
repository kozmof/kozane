import { resolveShortId } from "./short-id.js";

/**
 * Resolve a layer by name, full ID, or short ID within its namespace.
 *
 * Try an exact name first, then a case-insensitive name. Reject ambiguous case-insensitive
 * matches instead of choosing a layer.
 */
export function resolveLayerRef(layers: { id: string; name: string }[], requested: string): string {
  const byName = layers.find(({ name }) => name === requested);
  if (byName) return byName.id;

  const folded = requested.toLowerCase();
  const byFoldedName = layers.filter(({ name }) => name.toLowerCase() === folded);
  if (byFoldedName.length === 1) return byFoldedName[0].id;
  if (byFoldedName.length > 1) {
    const names = byFoldedName.map(({ name }) => `"${name}"`).join(", ");
    throw new Error(`Ambiguous layer name: ${requested}. Matches ${names}.`);
  }

  return resolveShortId(
    requested,
    layers.map(({ id }) => id),
    "Layer",
  );
}
