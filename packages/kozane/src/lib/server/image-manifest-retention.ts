/** Verify local bytes while keeping reservation, owner publication and cleanup serialized. */
import { withTx, type DB, type Tx } from "../../db/database.js";
import { lockImageAssetWork } from "../../db/api/image-upload.js";
import {
  assertImageAssetIdentityInTx,
  confirmVerifiedAssetManifestInTx,
  readAssetManifest,
  type AssetManifestOwner,
} from "../../db/api/asset-manifest.js";
import { inspectRetainedImage } from "./image-upload-evidence.js";

/** Caller may commit its dependent baseline/effect/recovery record in this same transaction. */
export async function retainImageManifestInTx(tx: Tx, root: string, input: AssetManifestOwner) {
  const key = { ...input };
  await lockImageAssetWork(tx);
  const current = await readAssetManifest(tx, key);
  if (current.record.state === "released") throw new Error("Asset manifest was released");
  await assertImageAssetIdentityInTx(tx, current.manifest);
  for (const entry of current.manifest.entries) {
    const observation = await inspectRetainedImage(root, {
      filename: entry.name.slice(".kozane/assets/images/".length),
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    });
    if (observation !== "matching-content")
      throw new Error(`Required image is ${observation}: ${entry.name}`);
  }
  return confirmVerifiedAssetManifestInTx(tx, key, current.record.manifest);
}

export function retainImageManifest(db: DB, root: string, input: AssetManifestOwner) {
  const key = { ...input };
  return withTx(db, (tx) => retainImageManifestInTx(tx, root, key));
}
