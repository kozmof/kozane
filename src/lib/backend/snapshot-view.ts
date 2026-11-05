import type {
  BackendInvalidation,
  BackendState,
  BackendVersion,
  SnapshotData,
  SnapshotResult,
} from "./contract.js";
export interface SnapshotBackend {
  readonly version: BackendVersion;
  readonly state: BackendState;
  subscribe(listener: (event: BackendInvalidation) => void): () => void;
  subscribeState(listener: (state: BackendState) => void): () => void;
  snapshot(namespaceId: string, options?: { validator?: string }): Promise<SnapshotResult>;
}
export interface ViewActivity {
  readonly idle: boolean;
  readonly version: number;
  unchangedSince(version: number): boolean;
}
/** Subscribe before reading, and apply only results still belonging to this active view. */
export function startSnapshotView(options: {
  backend: SnapshotBackend;
  initialDataApplied?: boolean;
  namespaceId: () => string;
  activities: readonly ViewActivity[];
  apply: (data: SnapshotData) => void;
  isHidden: () => boolean;
  error?: (error: unknown) => void;
}): () => void {
  const { backend } = options;
  let disposed = false,
    running = false,
    dirty = !options.initialDataApplied,
    sequence = 0;
  let currentNamespace = options.namespaceId();
  let applied: { namespaceId: string; generation: number; validator: string } | undefined;
  const refresh = async () => {
    if (
      disposed ||
      running ||
      !dirty ||
      options.isHidden() ||
      backend.state.status !== "ready" ||
      options.activities.some((activity) => !activity.idle)
    )
      return;
    running = true;
    dirty = false;
    const namespaceId = options.namespaceId(),
      generation = backend.version.generation,
      request = sequence;
    const activityVersions = options.activities.map((activity) => activity.version);
    try {
      const validator =
        applied?.namespaceId === namespaceId && applied.generation === generation
          ? applied.validator
          : undefined;
      const result = await backend.snapshot(namespaceId, { validator });
      if (disposed) return;
      if (
        sequence !== request ||
        options.namespaceId() !== namespaceId ||
        backend.version.generation !== generation ||
        backend.state.status !== "ready" ||
        options.isHidden() ||
        !options.activities.every((activity, index) =>
          activity.unchangedSince(activityVersions[index]),
        )
      ) {
        dirty = true;
        return;
      }
      if (result.status === "changed") options.apply(result.data);
      applied = { namespaceId, generation, validator: result.validator };
    } catch (error) {
      if (!disposed) {
        dirty = true;
        options.error?.(error);
      }
    } finally {
      running = false;
    }
  };
  const invalidate = () => {
    sequence++;
    dirty = true;
    void refresh();
  };
  const unsubscribe = backend.subscribe((event) => {
    if (
      event.datasets.includes("snapshot") &&
      (!event.namespaceIds || event.namespaceIds.includes(options.namespaceId()))
    )
      invalidate();
  });
  const unsubscribeState = backend.subscribeState((state) => {
    if (state.status !== "ready") {
      sequence++;
      dirty = true;
    } else void refresh();
  });
  const timer = setInterval(() => {
    const next = options.namespaceId();
    if (next !== currentNamespace) {
      currentNamespace = next;
      applied = undefined;
      sequence++;
      dirty = true;
    }
    void refresh();
  }, 1000);
  void refresh();
  return () => {
    disposed = true;
    sequence++;
    clearInterval(timer);
    unsubscribe();
    unsubscribeState();
  };
}
