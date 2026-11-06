import { schemaVersion } from "@kozane/core/migrations";
import { AssetVerificationError } from "./verified-loader";
import { AttemptOwner, SupersededAttemptError } from "./attempt";
import { DestinationTracker } from "./navigation";
import { restoreCandidate, HarnessFailure } from "./recovery";
import { WorkerContext, type HarnessManifest } from "./worker-context";
import { openResetSession } from "./session";
declare const __RESTORATION_MANIFEST__: HarnessManifest;
const manifest = __RESTORATION_MANIFEST__;
const attempts = new AttemptOwner();
async function run(
  namespaceId?: string,
  controls: {
    navigation?: DestinationTracker;
    rpcTimeoutMs?: number;
    healthTimeoutMs?: number;
    beforeView?: (namespaceId?: string) => Promise<void>;
  } = {},
) {
  const attempt = attempts.begin();
  const context = new WorkerContext(manifest, controls.rpcTimeoutMs, controls.healthTimeoutMs);
  const unsubscribe = attempt.onSuperseded(() => context.dispose(new SupersededAttemptError()));
  try {
    attempt.assertCurrent();
    await context.load(() => attempt.assertCurrent());
    const result = await restoreCandidate({
      schemaVersion,
      attempt,
      publication: context,
      namespaceId,
      navigation: controls.navigation,
      beforeView: controls.beforeView,
      storage: () => sessionStorage,
      sample: async () => context.sample(),
      open: (bytes) => context.open(bytes),
    });
    await context.ready();
    attempt.assertCurrent();
    if (result.status === "ready") {
      const { candidate, ...report } = result;
      await candidate.close();
      attempt.assertCurrent();
      return { ...report, attempt: attempt.attempt, generation: attempt.generation };
    }
    return result;
  } catch (error) {
    if (!attempt.isCurrent() || error instanceof SupersededAttemptError)
      return { status: "superseded" };
    const failure =
      error instanceof AssetVerificationError
        ? new HarnessFailure("asset", "Build asset verification failed")
        : error;
    return {
      status: "unavailable",
      action: failure instanceof HarnessFailure && failure.kind === "asset" ? "reload" : "retry",
      kind: failure instanceof HarnessFailure ? failure.kind : "unknown",
    };
  } finally {
    unsubscribe();
    context.dispose();
  }
}
function start(namespaceId?: string, beforeView?: (namespaceId?: string) => Promise<void>) {
  const navigation = new DestinationTracker(namespaceId);
  return {
    navigate: (id?: string) => navigation.select(id),
    result: run(namespaceId, { navigation, beforeView }),
  };
}
Object.assign(window, {
  restorationHarness: {
    run,
    start,
    manifest,
    schemaVersion,
    openSession: (
      namespaceId?: string,
      controls?: { healthTimeoutMs?: number; rpcTimeoutMs?: number },
    ) => openResetSession(manifest, namespaceId, controls),
    replaceGeneration: () => attempts.replaceGeneration(),
    isCurrent: (ticket: { attempt: number; generation: number }) => attempts.isCurrent(ticket),
  },
});
document.body.dataset.harness = "ready";
