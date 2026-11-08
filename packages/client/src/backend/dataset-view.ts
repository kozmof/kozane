import type { PollLifecycle } from "./workspace-poller.js";
import type { ClientDataset, KozaneClient, ReadOptions } from "./contract.js";
export type DatasetClient = Pick<
  KozaneClient,
  "version" | "state" | "subscribe" | "subscribeState"
>;
/** Subscribe before reading, and retain applied data until a current read succeeds. */
export function startDatasetView<T>(options: {
  backend: DatasetClient;
  dataset: ClientDataset;
  /** Internal readers can guard incremental results before their promise settles. */
  read: (isCurrent: () => boolean, options: ReadOptions) => Promise<T>;
  apply: (value: T) => void;
  isHidden: () => boolean;
  /** Static data needs no scheduled retries. */
  retryIntervalMs?: number | false;
  lifecycle?: Pick<PollLifecycle, "listen">;
  error?: (error: unknown) => void;
  /** Application callback failures do not trigger read retries. */
  callbackError?: (error: unknown) => void;
}): () => void {
  const { backend } = options;
  let disposed = false,
    running = false,
    dirty = true,
    sequence = 0;
  let pending: AbortController | undefined;
  let observedGeneration = backend.version.generation;
  const refresh = async () => {
    if (disposed || running || !dirty || options.isHidden() || backend.state.status !== "ready")
      return;
    running = true;
    dirty = false;
    const controller = new AbortController();
    pending = controller;
    const request = sequence,
      generation = backend.version.generation;
    try {
      const result = await options.read(
        () =>
          !disposed &&
          sequence === request &&
          generation === backend.version.generation &&
          backend.state.status === "ready" &&
          !options.isHidden(),
        { signal: controller.signal },
      );
      if (disposed || controller.signal.aborted) return;
      if (
        sequence !== request ||
        generation !== backend.version.generation ||
        options.isHidden() ||
        backend.state.status !== "ready"
      ) {
        dirty = true;
        return;
      }
      try {
        options.apply(result);
      } catch (error) {
        try {
          options.callbackError?.(error);
        } catch {
          // Diagnostics must not interrupt the view lifecycle.
        }
      }
    } catch (error) {
      if (!disposed) {
        dirty = true;
        if (
          sequence === request &&
          generation === backend.version.generation &&
          backend.state.status === "ready" &&
          !options.isHidden()
        )
          options.error?.(error);
      }
    } finally {
      if (pending === controller) pending = undefined;
      running = false;
      if (!disposed && dirty && sequence !== request) void refresh();
    }
  };
  const unsubscribe = backend.subscribe((event) => {
    if (event.generation !== observedGeneration || event.datasets.includes(options.dataset)) {
      observedGeneration = event.generation;
      sequence++;
      pending?.abort();
      dirty = true;
      void refresh();
    }
  });
  const unsubscribeState = backend.subscribeState((state) => {
    if (state.status !== "ready") {
      sequence++;
      pending?.abort();
      dirty = true;
    } else void refresh();
  });
  const releaseWake = options.lifecycle?.listen(() => {
    void refresh();
  });
  const timer =
    options.retryIntervalMs === false
      ? undefined
      : setInterval(() => {
          void refresh();
        }, options.retryIntervalMs ?? 1000);
  void refresh();
  return () => {
    disposed = true;
    sequence++;
    pending?.abort();
    if (timer !== undefined) clearInterval(timer);
    unsubscribe();
    unsubscribeState();
    releaseWake?.();
  };
}
