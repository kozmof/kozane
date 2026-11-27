/** Copy verified bundle images into a staged destination under durable, cleanup-aware protection. */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { parseAssetManifest, type AssetManifest } from "@kozane/core";
import {
  readRecoveryStagingDestination,
  inspectRecoveryStagingDestination,
  parseLocalRecoveryIdentity,
  parseRecoveryBundleCheckpoint,
  type RecoveryStagingDestination,
  type LocalRecoveryIdentity,
  type RecoveryBundleCheckpoint,
} from "@kozane/core/recovery";
import {
  withTx,
  configureActionConnection,
  verifyActionConnection,
  type DB,
  type Tx,
} from "../../db/database.js";
import { lockImageAssetWork } from "../../db/api/image-upload.js";
import {
  reserveAssetManifestInTx,
  readAssetManifest,
  type AssetManifestOwner,
} from "../../db/api/asset-manifest.js";
import { retainImageManifestInTx } from "./image-manifest-retention.js";
import { loadRegisteredRecoveryBundle } from "./recovery-bundle.js";
import { publishRecoveryImage } from "./recovery-image-files.js";
export interface RecoveryImageInstallation {
  readonly checkpoint: RecoveryBundleCheckpoint;
  readonly destinationIdentity: LocalRecoveryIdentity;
  readonly mode: RecoveryStagingDestination["mode"];
  readonly owner: AssetManifestOwner;
  readonly manifest: AssetManifest;
  readonly copied: number;
  readonly reused: number;
  readonly changed: boolean;
}
type Options = Parameters<typeof loadRegisteredRecoveryBundle>[0] & {
  destination: DB;
  destinationRoot: string;
  destinationExpected: LocalRecoveryIdentity;
  mode: RecoveryStagingDestination["mode"];
};
/** A stable pin identity, never an installation or activation receipt. */
export function registeredRecoveryDestinationImageOwner(
  staging: RecoveryStagingDestination,
): AssetManifestOwner {
  const { checkpoint, destinationIdentity: identity, mode } = staging;
  const binding = [
    mode,
    checkpoint.version,
    checkpoint.byteLength,
    checkpoint.sha256,
    identity.workspaceId,
    identity.deviceId,
    identity.epochId,
    identity.checkpointId,
    identity.schemaId,
  ];
  return Object.freeze({
    kind: "recovery",
    id:
      "installed-recovery:v1:" + createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
  });
}
function own(options: Options) {
  const {
    db,
    destination,
    root,
    destinationRoot,
    createValidationDatabase,
    maxBytes,
    localMaxBytes,
    sharedMaxBytes,
    executionMaxBytes,
    actionMaxBytes,
    actionArchiveMaxBytes,
    runArchiveMaxBytes,
    assetMaxBytes,
    runAssetMaxBytes,
    mode,
  } = options;
  if (db === destination)
    throw new Error("Image installation requires a separate destination database");
  if (
    [root, destinationRoot].some((path) => typeof path !== "string" || !path || path.includes("\0"))
  )
    throw new Error("Image installation requires explicit workspace roots");
  if (
    ![
      maxBytes,
      localMaxBytes,
      sharedMaxBytes,
      executionMaxBytes,
      actionMaxBytes,
      actionArchiveMaxBytes,
      runArchiveMaxBytes,
      assetMaxBytes,
      runAssetMaxBytes,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error("Payload read limits must be positive safe integers");
  const expected = parseLocalRecoveryIdentity(options.expected),
    destinationExpected = parseLocalRecoveryIdentity(options.destinationExpected),
    checkpoint = parseRecoveryBundleCheckpoint(options.checkpoint);
  return {
    destination,
    destinationRoot: resolve(destinationRoot),
    destinationExpected,
    mode,
    source: {
      db,
      root: resolve(root),
      createValidationDatabase,
      maxBytes,
      localMaxBytes,
      sharedMaxBytes,
      executionMaxBytes,
      actionMaxBytes,
      actionArchiveMaxBytes,
      runArchiveMaxBytes,
      assetMaxBytes,
      runAssetMaxBytes,
      expected,
      checkpoint,
    },
  };
}
async function requireOwner(tx: Tx, owner: AssetManifestOwner, manifest: AssetManifest) {
  const current = await readAssetManifest(tx, owner);
  if (current.record.state === "released")
    throw new Error("Destination recovery image protection was released");
  if (current.record.manifest !== JSON.stringify(manifest))
    throw new Error("Destination recovery image requirements changed");
  for (const date of [
    current.record.createdAt,
    current.record.verifiedAt,
    current.record.releasedAt,
  ])
    if (date !== null && !Number.isSafeInteger(date.getTime()))
      throw new Error("Destination recovery owner timestamps cannot be represented safely");
  return current;
}
/** Every attempt reloads the complete source bundle and rechecks physical destination bytes. */
export async function installRegisteredRecoveryBundleImages(
  options: Options,
): Promise<RecoveryImageInstallation> {
  const { destination, destinationRoot, destinationExpected, mode, source } = own(options);
  const staging = await inspectRecoveryStagingDestination(
    destination,
    source.checkpoint,
    source.expected,
    destinationExpected,
    mode,
  );
  const sourceRoot = await fs.realpath(source.root),
    targetRoot = await fs.realpath(destinationRoot);
  if (sourceRoot === targetRoot)
    throw new Error("Source and destination image roots must be separate");
  const [sourceStat, targetStat] = await Promise.all([
    fs.stat(sourceRoot, { bigint: true }),
    fs.stat(targetRoot, { bigint: true }),
  ]);
  if (!sourceStat.isDirectory() || !targetStat.isDirectory())
    throw new Error("Image installation roots must be directories");
  if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)
    throw new Error("Source and destination image roots must be separate");
  const bundle = await loadRegisteredRecoveryBundle(source),
    manifest = parseAssetManifest(bundle.index.manifest),
    owner = registeredRecoveryDestinationImageOwner(staging);
  const checkStage = (tx: Tx) =>
    readRecoveryStagingDestination(
      tx,
      source.checkpoint,
      source.expected,
      destinationExpected,
      mode,
    );
  const reservation = await withTx(destination, async (tx) => {
    await lockImageAssetWork(tx);
    await configureActionConnection((query) => tx.values(sql.raw(query)));
    await checkStage(tx);
    const reserved = await reserveAssetManifestInTx(tx, owner, manifest);
    await requireOwner(tx, owner, manifest);
    await verifyActionConnection((query) => tx.values(sql.raw(query)));
    return reserved.changed;
  });
  const result = await withTx(destination, async (tx) => {
    await lockImageAssetWork(tx);
    await configureActionConnection((query) => tx.values(sql.raw(query)));
    await checkStage(tx);
    await requireOwner(tx, owner, manifest);
    let copied = 0,
      reused = 0;
    for (const image of manifest.entries) {
      const published = await publishRecoveryImage(
        sourceRoot,
        targetRoot,
        source.checkpoint.sha256,
        image,
        async () => {
          await requireOwner(tx, owner, manifest);
        },
      );
      if (published.changed) copied++;
      else reused++;
    }
    const retained = await retainImageManifestInTx(tx, targetRoot, owner);
    await checkStage(tx);
    await requireOwner(tx, owner, manifest);
    await verifyActionConnection((query) => tx.values(sql.raw(query)));
    return { copied, reused, changed: reservation || copied > 0 || retained.changed };
  });
  return Object.freeze({ ...staging, owner, manifest, ...result });
}
