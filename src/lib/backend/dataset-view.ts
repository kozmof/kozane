import type {
  BackendDataset,
  BackendInvalidation,
  BackendState,
  BackendVersion,
} from "./contract.js";
export interface DatasetBackend {
  readonly version: BackendVersion;
  readonly state: BackendState;
  subscribe(listener: (event: BackendInvalidation) => void): () => void;
  subscribeState(listener: (state: BackendState) => void): () => void;
}
/** Subscribe before reading, and retain applied data until a current read succeeds. */
export function startDatasetView<T>(options: {
  backend: DatasetBackend;
  dataset: BackendDataset;
  read: () => Promise<T>;
  apply: (value: T) => void;
  isHidden: () => boolean;
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
    } catch {
      if (!disposed) dirty = true;
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
  const timer = setInterval(() => {
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
