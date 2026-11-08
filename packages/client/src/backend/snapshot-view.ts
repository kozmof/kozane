import type { PollLifecycle } from "./workspace-poller.js";
import { ClientError } from "./contract.js";
import type { KozaneClient, SnapshotData } from "./contract.js";
export type SnapshotClient = Pick<
  KozaneClient,
  "version" | "state" | "subscribe" | "subscribeState" | "snapshot"
>;
export interface ViewActivity {
  readonly idle: boolean;
  readonly version: number;
  unchangedSince(version: number): boolean;
}
export interface SnapshotViewStatus {
  current: boolean;
  namespaceId: string;
  generation: number;
}
/** Subscribe before reading, and apply only results still belonging to this active view. */
export function startSnapshotView(options: {
  backend: SnapshotClient;
  initialDataApplied?: boolean;
  /** Revalidate a trusted seed without discarding its current-generation status. */
  refreshInitially?: boolean;
  namespaceId: () => string;
  activities: readonly ViewActivity[];
  apply: (data: SnapshotData) => void;
  isHidden: () => boolean;
  /** Static data needs no scheduled retries. */
  retryIntervalMs?: number | false;
  lifecycle?: Pick<PollLifecycle, "listen">;
  error?: (error: unknown) => void;
  refreshed?: () => void;
  status?: (status: SnapshotViewStatus) => void;
}): () => void {
  const { backend } = options;
  let disposed = false,
    running = false,
    dirty = !options.initialDataApplied || options.refreshInitially === true,
    sequence = 0;
  let currentNamespace = options.namespaceId();
  let applied: { namespaceId: string; generation: number; validator: string } | undefined;
  let generationSeen = backend.version.generation;
  let validated =
    options.initialDataApplied && backend.state.status === "ready"
      ? { namespaceId: currentNamespace, generation: generationSeen }
      : undefined;
  const report = () =>
    options.status?.({
      current:
        validated?.namespaceId === options.namespaceId() &&
        validated?.generation === backend.version.generation &&
        backend.state.status === "ready",
      namespaceId: options.namespaceId(),
      generation: backend.version.generation,
    });
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
      if (result.status === "unchanged" && validator === undefined)
        throw new ClientError("unavailable", "Snapshot validation requires current data");
      if (result.status === "changed") {
        if (result.data.namespace.id !== namespaceId)
          throw new ClientError("unavailable", "Snapshot belongs to another namespace");
        options.apply(result.data);
      }
      validated = { namespaceId, generation };
      options.refreshed?.();
      report();
      applied = { namespaceId, generation, validator: result.validator };
    } catch (error) {
      if (!disposed) {
        dirty = true;
        if (
          sequence === request &&
          options.namespaceId() === namespaceId &&
          backend.version.generation === generation &&
          backend.state.status === "ready" &&
          !options.isHidden() &&
          options.activities.every((activity, index) =>
            activity.unchangedSince(activityVersions[index]),
          )
        )
          options.error?.(error);
      }
    } finally {
      running = false;
      if (!disposed && dirty && request !== sequence) void refresh();
    }
  };
  const invalidate = () => {
    sequence++;
    dirty = true;
    void refresh();
  };
  report();
  const unsubscribe = backend.subscribe((event) => {
    if (generationSeen !== backend.version.generation) {
      generationSeen = backend.version.generation;
      validated = undefined;
      applied = undefined;
      report();
      invalidate();
      return;
    }
    if (
      event.datasets.includes("snapshot") &&
      (!event.namespaceIds || event.namespaceIds.includes(options.namespaceId()))
    )
      invalidate();
  });
  const unsubscribeState = backend.subscribeState((state) => {
    if (state.status !== "ready") {
      validated = undefined;
      applied = undefined;
      sequence++;
      dirty = true;
    } else void refresh();
    report();
  });
  const releaseWake = options.lifecycle?.listen(() => {
    void refresh();
  });
  const timer =
    options.retryIntervalMs === false
      ? undefined
      : setInterval(() => {
          const next = options.namespaceId();
          if (next !== currentNamespace) {
            currentNamespace = next;
            applied = undefined;
            validated = undefined;
            report();
            sequence++;
            dirty = true;
          }
          void refresh();
        }, options.retryIntervalMs ?? 1000);
  void refresh();
  return () => {
    disposed = true;
    sequence++;
    if (timer !== undefined) clearInterval(timer);
    unsubscribe();
    unsubscribeState();
    releaseWake?.();
  };
}
