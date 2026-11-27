/** Manifest coverage for shared baseline and row-effect images. Hosts retain full invocation requirements. */
import {
  parseAssetManifest,
  selectAssetManifest,
  mergeAssetManifests,
  baselineAssetNames,
  effectAssetNames,
  type AssetManifest,
} from "./asset-manifest.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import { parseSharedRecoveryHistoryPayload } from "./shared-recovery-checkpoint.js";

type HistoryImages = Readonly<{ id: string; manifest: AssetManifest }>;
export type SharedRecoveryHistoryImages = Readonly<{
  baseline: HistoryImages;
  effectSets: readonly HistoryImages[];
}>;
function fields(input: unknown, names: readonly string[]) {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new SharedRecoveryError("Invalid checkpoint history images");
  return Object.fromEntries(
    names.map((name) => {
      const field = Object.getOwnPropertyDescriptor(input, name);
      if (!field || !("value" in field) || !field.enumerable)
        throw new SharedRecoveryError("Checkpoint history images require plain data");
      return [name, field.value];
    }),
  );
}
function entry(input: unknown): HistoryImages {
  const value = fields(input, ["id", "manifest"]);
  if (
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.id.length > 1000 ||
    value.id.includes("\0") ||
    !value.id.isWellFormed()
  )
    throw new SharedRecoveryError("Invalid checkpoint history identity");
  return Object.freeze({ id: value.id, manifest: parseAssetManifest(value.manifest) });
}
export function parseSharedRecoveryHistoryImages(input: unknown): SharedRecoveryHistoryImages {
  const value = fields(input, ["baseline", "effectSets"]);
  if (
    !Array.isArray(value.effectSets) ||
    Reflect.ownKeys(value.effectSets).length !== value.effectSets.length + 1
  )
    throw new SharedRecoveryError("Invalid checkpoint history image list");
  const effectSets = value.effectSets;
  return Object.freeze({
    baseline: entry(value.baseline),
    effectSets: Object.freeze(
      Array.from({ length: effectSets.length }, (_, index) => {
        const field = Object.getOwnPropertyDescriptor(effectSets, String(index));
        if (!field || !("value" in field) || !field.enumerable)
          throw new SharedRecoveryError("Checkpoint history images require plain entries");
        return entry(field.value);
      }),
    ),
  });
}

/** Require every referenced row image while preserving extra requirements from full retained invocations. */
export function sharedRecoveryAssetManifest(input: unknown, images: unknown): AssetManifest {
  const history = parseSharedRecoveryHistoryImages(images);
  const payload = parseSharedRecoveryHistoryPayload(input);
  if (
    history.baseline.id !== payload.selection.baselineId ||
    history.effectSets.length !== payload.selection.effectSets.length ||
    history.effectSets.some((entry, index) => entry.id !== payload.selection.effectSets[index].id)
  )
    throw new SharedRecoveryError("History images do not match shared checkpoint selection");
  selectAssetManifest(
    history.baseline.manifest,
    baselineAssetNames(
      payload.history.baseline.projection.tables.flatMap(({ name, rows }) =>
        rows.map((row) => ({ table: name, row })),
      ),
    ),
  );
  for (const [index, set] of payload.history.effectSets.entries())
    selectAssetManifest(history.effectSets[index].manifest, effectAssetNames([], set.effects));
  return mergeAssetManifests([
    history.baseline.manifest,
    ...history.effectSets.map(({ manifest }) => manifest),
  ]);
}
