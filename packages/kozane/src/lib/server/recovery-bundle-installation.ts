/** Explicitly stage local or shared rows from complete registered bundles without activation. */
import type { DB } from "../../db/database.js";
import {
  checkLocalRecoveryInstallation,
  checkSharedRecoveryInstallation,
  installSharedRecoverySnapshot,
  installLocalRecoverySnapshot,
  parseLocalRecoveryIdentity,
  parseRecoveryBundleCheckpoint,
} from "@kozane/core/recovery";
import { loadRegisteredRecoveryBundle } from "./recovery-bundle.js";

type Options = Parameters<typeof loadRegisteredRecoveryBundle>[0] & { destination: DB };
async function installBundleSnapshot(options: Options, kind: "local" | "shared") {
  const check = kind === "local" ? checkLocalRecoveryInstallation : checkSharedRecoveryInstallation;
  const install = kind === "local" ? installLocalRecoverySnapshot : installSharedRecoverySnapshot;
  const {
    root,
    db,
    destination,
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
  } = options;
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
    ].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new Error("Payload read limits must be positive safe integers");
  const expected = parseLocalRecoveryIdentity(options.expected),
    checkpoint = parseRecoveryBundleCheckpoint(options.checkpoint);
  const already = await check(destination, checkpoint, expected);
  if (already) return Object.freeze({ checkpoint: already, changed: false });
  const bundle = await loadRegisteredRecoveryBundle({
    root,
    db,
    expected,
    checkpoint,
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
  });
  return install(
    destination,
    createValidationDatabase,
    kind === "local" ? bundle.contents.localSnapshot : bundle.contents.sharedHistory,
    checkpoint,
    expected,
  );
}

export function installRegisteredRecoveryBundleLocalSnapshot(options: Options) {
  return installBundleSnapshot(options, "local");
}
/** Stage shared rows after matching local installation. History, images and activation remain separate. */
export function installRegisteredRecoveryBundleSharedSnapshot(options: Options) {
  return installBundleSnapshot(options, "shared");
}
