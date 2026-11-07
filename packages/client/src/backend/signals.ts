import {
  BackendError,
  type BackendDataset,
  type BackendInvalidation,
  type BackendState,
  type BackendVersion,
} from "./contract.js";

/** Backend-owned lifecycle and committed-data publications. */
export class BackendSignals {
  private currentVersion: BackendVersion = Object.freeze({ generation: 0, revision: 0 });
  private currentState: BackendState;
  private readonly dataListeners = new Set<(event: BackendInvalidation) => void>();
  private readonly stateListeners = new Set<(state: BackendState) => void>();
  private disposed = false;
  constructor(
    state: BackendState,
    private readonly listenerError: (error: unknown) => void = () => {},
  ) {
    this.currentState = Object.freeze({ ...state });
  }
  get version(): BackendVersion {
    return this.currentVersion;
  }
  get state(): BackendState {
    return this.currentState;
  }
  subscribe(listener: (event: BackendInvalidation) => void): () => void {
    if (this.disposed) return () => {};
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }
  subscribeState(listener: (state: BackendState) => void): () => void {
    if (this.disposed) return () => {};
    this.stateListeners.add(listener);
    try {
      listener(this.currentState);
    } catch (error) {
      this.listenerError(error);
    }
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  transition(state: BackendState): void {
    this.assertActive();
    this.currentState = Object.freeze({ ...state });
    this.notify(this.stateListeners, this.currentState);
  }
  /** Call only after a successful committed write or an observed external change. */
  publish(
    datasets: readonly BackendDataset[],
    namespaceIds?: readonly string[],
    reset = false,
  ): BackendInvalidation {
    this.assertActive();
    if (datasets.length === 0 || namespaceIds?.length === 0)
      throw new BackendError("validation", "Invalidation targets must not be empty");
    this.currentVersion = Object.freeze(
      reset
        ? { generation: this.version.generation + 1, revision: 0 }
        : { generation: this.version.generation, revision: this.version.revision + 1 },
    );
    const event: BackendInvalidation = Object.freeze({
      ...this.version,
      datasets: Object.freeze([...new Set(datasets)]),
      ...(namespaceIds ? { namespaceIds: Object.freeze([...new Set(namespaceIds)]) } : {}),
    });
    this.notify(this.dataListeners, event);
    return event;
  }
  dispose(): void {
    this.disposed = true;
    this.dataListeners.clear();
    this.stateListeners.clear();
  }
  private assertActive() {
    if (this.disposed) throw new BackendError("unavailable", "Backend is disposed");
  }
  private notify<T>(listeners: Set<(event: T) => void>, event: T) {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(event);
      } catch (error) {
        this.listenerError(error);
      }
    }
  }
}
