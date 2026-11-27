/** Image requirements and immutable name identity in a complete local checkpoint. */
import { IMAGE_MAX_BYTES } from "../images.js";
import { mergeAssetManifests, parseAssetManifest, type AssetManifest } from "./asset-manifest.js";
import { LocalRecoveryError, parseLocalRecoverySnapshot } from "./local-recovery.js";
import type { TaggedRow } from "./row-codec.js";

function text(row: TaggedRow, column: string): string {
  const value = row[column];
  if (value[0] !== "text")
    throw new LocalRecoveryError(`Local asset metadata requires TEXT: ${column}`);
  return value[1];
}

/** Pending requirements remain required even before file creation. This does not verify availability. */
export function localRecoveryAssetManifest(
  input: unknown,
  history: readonly unknown[] = [],
): AssetManifest {
  const snapshot = parseLocalRecoverySnapshot(input);
  const selected = history.map(parseAssetManifest);
  const identities: AssetManifest[] = [];
  const required: AssetManifest[] = [];
  for (const table of snapshot.tables) {
    if (table.name === "local_image_upload")
      for (const row of table.rows) {
        const state = text(row, "state");
        if (!["pending", "installed", "completed", "abandoned"].includes(state))
          throw new LocalRecoveryError("Unknown local image upload state");
        const length = row.byte_length;
        if (length[0] !== "integer")
          throw new LocalRecoveryError("Local image byte length requires INTEGER");
        const bytes = BigInt(length[1]);
        if (bytes < 1n || bytes > BigInt(IMAGE_MAX_BYTES))
          throw new LocalRecoveryError("Invalid local image byte length");
        const manifest = parseAssetManifest({
          version: 1,
          entries: [
            {
              name: `.kozane/assets/images/${text(row, "filename")}`,
              byteLength: Number(bytes),
              sha256: text(row, "sha256"),
            },
          ],
        });
        identities.push(manifest);
        if (state === "pending" || state === "installed") required.push(manifest);
      }
    if (table.name === "local_asset_manifest")
      for (const row of table.rows) {
        const kind = text(row, "owner_kind");
        const owner = text(row, "owner_id");
        const state = text(row, "state");
        if (
          !["baseline", "effect-set", "pending-work", "transfer", "recovery"].includes(kind) ||
          !owner.trim() ||
          owner.length > 1000 ||
          owner.includes("\0")
        )
          throw new LocalRecoveryError("Invalid local manifest owner");
        if (!["pending", "retained", "released"].includes(state))
          throw new LocalRecoveryError("Unknown local asset manifest state");
        const manifest = parseAssetManifest(JSON.parse(text(row, "manifest")));
        identities.push(manifest);
        if (state !== "released") required.push(manifest);
      }
  }
  // Completed uploads and released owners retain immutable identity after their bytes stop being required.
  mergeAssetManifests([...identities, ...selected]);
  return mergeAssetManifests([...required, ...selected]);
}
