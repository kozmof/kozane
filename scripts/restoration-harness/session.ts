import { schemaVersion } from "@kozane/core/migrations";
import { OperationQueue } from "./operation-queue";
import { AssetVerificationError } from "./verified-loader";
import { restoreCandidate, HarnessFailure, type CandidateRequest } from "./recovery";
import { ResetSession } from "./reset";
import { WorkerContext, type WorkerCandidate, type HarnessManifest } from "./worker-context";
/** A retained harness case has its own root lifetime and queue; all reset candidates are staged. */
export async function openResetSession(
  manifest: HarnessManifest,
  namespaceId?: string,
  controls: { healthTimeoutMs?: number; rpcTimeoutMs?: number } = {},
) {
  const context = new WorkerContext(manifest, controls.rpcTimeoutMs, controls.healthTimeoutMs);
  const queue = new OperationQueue();
  let closed = false;
  const assertActive = () => {
    if (closed) throw new HarnessFailure("unknown", "Session is closed");
  };
  try {
    await context.load();
    let latest: WorkerCandidate | undefined;
    const restored = await restoreCandidate({
      schemaVersion,
      publication: context,
      namespaceId,
      storage: () => sessionStorage,
      sample: async () => context.sample(),
      open: async (bytes) => {
        latest = await context.open(bytes);
        return latest;
      },
    });
    if (restored.status !== "ready") {
      context.dispose();
      return restored;
    }
    const initialNamespace =
      restored.view.kind === "selected"
        ? restored.view.namespaceId
        : (namespaceId ?? manifest.sampleNamespaceId);
    const session = new ResetSession(
      {
        generation: 0,
        candidate: latest!,
        view: restored.view,
        namespaceId: initialNamespace,
        url: location.pathname + location.search + location.hash,
      },
      (operation) =>
        queue.run(() => {
          assertActive();
          return operation();
        }),
    );
    const report = () => {
      const { candidate: _candidate, ...state } = session.state;
      return { ...state, liveWorkers: context.liveWorkers };
    };
    return {
      status: "ready" as const,
      state: report,
      read: () =>
        queue.run(() => {
          assertActive();
          return session.state.candidate.validate({
            namespaceId: session.state.generation === 0 ? namespaceId : session.state.namespaceId,
          });
        }),
      addCard: (content: string) =>
        queue.run(async () => {
          assertActive();
          const view = session.state.view;
          if (view.kind !== "selected")
            throw new HarnessFailure("unknown", "Select a namespace first");
          const candidate = session.state.candidate as WorkerCandidate;
          return candidate.createCard(
            view.namespaceId,
            view.snapshot.snapshot.partitions[0].id,
            content,
          );
        }),
      reset: async (
        controls: {
          fixtureSQL?: string;
          beforeView?: CandidateRequest["beforeView"];
          deleteFails?: boolean;
        } = {},
      ) => {
        assertActive();
        const result = await session.reset({
          publication: context,
          sample: async () => context.sample(),
          open: async (bytes) => {
            const candidate = await context.open(bytes);
            try {
              if (controls.fixtureSQL) await candidate.fixture(controls.fixtureSQL);
            } catch (error) {
              await candidate.close();
              throw error;
            }
            return {
              ...candidate,
              validate: (request) =>
                candidate.validate({ ...request, beforeView: controls.beforeView }),
            };
          },
          storage: () => {
            if (controls.deleteFails) throw new Error("Injected storage failure");
            return sessionStorage;
          },
          destination: (id) => `/board/?namespaceId=${encodeURIComponent(id)}`,
          navigate: (url) => history.replaceState(null, "", url),
        });
        if (result.status === "ready") {
          const { state: _state, ...rest } = result;
          return { ...rest, state: report() };
        }
        return result;
      },
      close: () =>
        queue.run(async () => {
          if (closed) return;
          closed = true;
          context.dispose();
        }),
    };
  } catch (error) {
    context.dispose();
    throw error instanceof AssetVerificationError
      ? new HarnessFailure("asset", "Build asset verification failed")
      : error;
  }
}
