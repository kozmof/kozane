import { resolveShortId } from "./short-id.js";

/**
 * How a layer can be named on the command line: its full id, a short id, or its name.
 * Names are unique per project, so all three identify one layer — and a name is tried
 * first, so a layer called `a1b2c3d` answers to its name rather than to whatever short
 * id that string might also match.
 */
export type LayerRef = string;

export function resolveLayerRef(
  layers: { id: string; name: string }[],
  requested: LayerRef,
): string {
  const byName = layers.find(({ name }) => name === requested);
  if (byName) return byName.id;
  return resolveShortId(
    requested,
    layers.map(({ id }) => id),
    "Layer",
  );
}
