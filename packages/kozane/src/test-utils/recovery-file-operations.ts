/** A complete local staging boundary whose captured snapshot contains the supplied journal evidence. */
import type { DB } from "@kozane/core/database";
import * as recovery from "@kozane/core/recovery";
import { runArchiveAssetFixture } from "./run-archive-assets.js";
import { identity } from "./retained-recovery-assets.js";
export async function stagedRecoveryFileOperations(
  factory: () => Promise<DB>,
  seed: (db: DB) => Promise<void>,
) {
  const source = await factory(),
    f = await runArchiveAssetFixture();
  await seed(source);
  const local = await recovery.captureLocalRecoveryCheckpoint(
    source,
    identity,
    async () => f.localSnapshot.selection,
  );
  const current = await recovery.describeRecoveryAssets({
    binding: {
      checkpoint: f.assetCheckpoint.binding.checkpoint,
      localCheckpoint: local.checkpoint,
    },
    localSnapshot: local.snapshot,
    sharedHistory: f.sharedHistory,
    history: f.currentAssets.history,
  });
  f.binding.localCheckpoint = local.checkpoint;
  f.assetCheckpoint = current.checkpoint;
  f.localSnapshot = local.snapshot;
  f.currentAssets = current.payload;
  const assets = await recovery.describeRunArchiveAssets(f),
    bundle = await recovery.describeRecoveryBundleIndex(assets.checkpoint, {
      localSnapshot: f.localSnapshot,
      sharedHistory: f.sharedHistory,
      executions: f.executions,
      originalActions: f.originalActions,
      actionArchive: f.actionArchive,
      runArchive: f.runArchive,
      currentAssets: f.currentAssets,
      runAssets: assets.payload,
    });
  const destination = await factory();
  await recovery.installLocalRecoverySnapshot(
    destination,
    factory,
    local.snapshot,
    bundle.checkpoint,
    identity,
  );
  return { source, destination, checkpoint: bundle.checkpoint, snapshot: local.snapshot };
}
