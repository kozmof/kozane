/** Complete broader run sources and manifests, including first-recorded inputs that never execute. */
import { describeSharedRecoveryRunArchive } from "@kozane/core/recovery";
import { mergeAssetManifests } from "@kozane/core";
import { sharedRecoveryRunArchiveFixture } from "./shared-recovery-run-archive.js";
import { retainedRecoveryAssetFixture, manifest, clone } from "./retained-recovery-assets.js";
export async function runArchiveAssetFixture() {
  const current = await retainedRecoveryAssetFixture(),
    runs = await sharedRecoveryRunArchiveFixture(),
    archive = await describeSharedRecoveryRunArchive(runs);
  return clone({
    binding: { checkpoint: archive.checkpoint, localCheckpoint: current.binding.localCheckpoint },
    assetCheckpoint: current.assetCheckpoint,
    history: runs.images,
    originalImages: mergeAssetManifests([current.originalImages, manifest(17, 18, 19, 20, 31)]),
    localSnapshot: current.localSnapshot,
    sharedHistory: current.sharedHistory,
    executions: current.executions,
    originalActions: current.originalActions,
    actionArchive: runs.actionArchive,
    runArchive: archive.payload,
    currentAssets: current.currentAssets,
  });
}
