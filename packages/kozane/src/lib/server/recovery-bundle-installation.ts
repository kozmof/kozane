/** Explicitly stage local or shared rows from complete registered bundles without activation. */
import type { DB } from "../../db/database.js";
import {
  checkSharedOnlyRecoveryInstallation,
  installSharedOnlyRecoverySnapshot,
  type LocalRecoveryIdentity,
  checkLocalRecoveryInstallation,
  checkSharedRecoveryInstallation,
  installSharedRecoverySnapshot,
  installLocalRecoverySnapshot,
  parseLocalRecoveryIdentity,
  parseRecoveryBundleCheckpoint,
} from "@kozane/core/recovery";
import { loadRegisteredRecoveryBundle } from "./recovery-bundle.js";

type Options = Parameters<typeof loadRegisteredRecoveryBundle>[0] & { destination: DB };
function ownOptions(options: Options) {
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
  return {
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
    expected,
    checkpoint,
  };
}
async function installBundleSnapshot(options: Options, kind: "local" | "shared") {
  const check = kind === "local" ? checkLocalRecoveryInstallation : checkSharedRecoveryInstallation;
  const install = kind === "local" ? installLocalRecoverySnapshot : installSharedRecoverySnapshot;
  const { destination, ...source } = ownOptions(options);
  const already = await check(destination, source.checkpoint, source.expected);
  if (already) return Object.freeze({ checkpoint: already, changed: false });
  const bundle = await loadRegisteredRecoveryBundle(source);
  return install(
    destination,
    source.createValidationDatabase,
    kind === "local" ? bundle.contents.localSnapshot : bundle.contents.sharedHistory,
    source.checkpoint,
    source.expected,
  );
}

export function installRegisteredRecoveryBundleLocalSnapshot(options: Options) {
  return installBundleSnapshot(options, "local");
}
/** Stage shared rows after matching local installation. History, images and activation remain separate. */
export function installRegisteredRecoveryBundleSharedSnapshot(options: Options) {
  return installBundleSnapshot(options, "shared");
}

/** Explicitly stage shared rows under an independently trusted receiving identity without local attachments. */
export async function installRegisteredRecoveryBundleSharedOnlySnapshot(
  options: Options & { destinationExpected: LocalRecoveryIdentity },
) {
  const destinationExpected = parseLocalRecoveryIdentity(options.destinationExpected);
  const { destination, ...source } = ownOptions(options);
  const already = await checkSharedOnlyRecoveryInstallation(
    destination,
    source.checkpoint,
    source.expected,
    destinationExpected,
  );
  if (already) return Object.freeze({ ...already, changed: false });
  const bundle = await loadRegisteredRecoveryBundle(source);
  return installSharedOnlyRecoverySnapshot(
    destination,
    source.createValidationDatabase,
    bundle.contents.sharedHistory,
    source.checkpoint,
    source.expected,
    destinationExpected,
  );
}
