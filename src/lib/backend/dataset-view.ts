import type { PollLifecycle } from "./workspace-poller.js";
import type { BackendDataset, KozaneBackend } from "./contract.js";
export type DatasetBackend = Pick<
  KozaneBackend,
  "version" | "state" | "subscribe" | "subscribeState"
>;
/** Subscribe before reading, and retain applied data until a current read succeeds. */
export function startDatasetView<T>(options: {
  backend: DatasetBackend;
  dataset: BackendDataset;
  read: () => Promise<T>;
  apply: (value: T) => void;
  isHidden: () => boolean;
  /** Static data needs no scheduled retries. */
  retryIntervalMs?: number | false;
  lifecycle?: Pick<PollLifecycle, "listen">;
  error?: (error: unknown) => void;
}): () => void {
  const { backend } = options;
  let disposed = false,
    running = false,
    dirty = true,
    sequence = 0;
  const refresh = async () => {
    if (disposed || running || !dirty || options.isHidden() || backend.state.status !== "ready")
      return;
    running = true;
    dirty = false;
    const request = sequence,
      generation = backend.version.generation;
    try {
      const result = await options.read();
      if (disposed) return;
      if (
        sequence !== request ||
        generation !== backend.version.generation ||
        options.isHidden() ||
        backend.state.status !== "ready"
      ) {
        dirty = true;
        return;
      }
      options.apply(result);
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
      running = false;
    }
  };
  const unsubscribe = backend.subscribe((event) => {
    if (event.datasets.includes(options.dataset)) {
      sequence++;
      dirty = true;
      void refresh();
    }
  });
  const unsubscribeState = backend.subscribeState((state) => {
    if (state.status !== "ready") {
      sequence++;
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
    if (timer !== undefined) clearInterval(timer);
    unsubscribe();
    unsubscribeState();
    releaseWake?.();
  };
}
