/** Verify local bytes while keeping reservation, owner publication and cleanup serialized. */
import type { AssetManifest } from "@kozane/core";
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
  await verifyImageBytes(tx, root, current.manifest);
  return confirmVerifiedAssetManifestInTx(tx, key, current.record.manifest);
}

export function retainImageManifest(db: DB, root: string, input: AssetManifestOwner) {
  const key = { ...input };
  return withTx(db, (tx) => retainImageManifestInTx(tx, root, key));
}

async function verifyImageBytes(tx: Tx, root: string, manifest: AssetManifest) {
  await assertImageAssetIdentityInTx(tx, manifest);
  for (const entry of manifest.entries) {
    const observation = await inspectRetainedImage(root, {
      filename: entry.name.slice(".kozane/assets/images/".length),
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    });
    if (observation !== "matching-content")
      throw new Error(`Required image is ${observation}: ${entry.name}`);
  }
}

/** Check an existing retained owner and physical bytes without publishing or promoting owner state. */
export async function verifyRetainedImageManifestInTx(
  tx: Tx,
  root: string,
  input: AssetManifestOwner,
) {
  const key = { ...input };
  await lockImageAssetWork(tx);
  const current = await readAssetManifest(tx, key);
  if (current.record.state !== "retained") throw new Error("Image protection is not retained");
  if (
    ![current.record.createdAt, current.record.verifiedAt, current.record.releasedAt].every(
      (date) => date === null || Number.isSafeInteger(date.getTime()),
    )
  )
    throw new Error("Asset manifest timestamps cannot be represented safely");
  await verifyImageBytes(tx, root, current.manifest);
  const after = await readAssetManifest(tx, key);
  if (JSON.stringify(after.record) !== JSON.stringify(current.record))
    throw new Error("Retained image owner changed during verification");
  return { ...current, changed: false };
}
