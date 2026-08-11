import { resolveShortId } from "./short-id.js";

/**
 * How a layer can be named on the command line: its full id, a short id, or its name.
 * Names are unique per project, so all three identify one layer — and a name is tried
 * first, so a layer called `a1b2c3d` answers to its name rather than to whatever short
 * id that string might also match.
 *
 * An exact name wins outright. Failing that, a case-insensitive match is accepted: names
 * are stored case-sensitively, and `--layer draft` failing against a project that visibly
 * has a `Draft` is not a distinction worth making at a prompt. Two layers differing only
 * in case is the one time that cannot be resolved, and it says so rather than picking.
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
