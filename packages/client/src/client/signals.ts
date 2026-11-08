import {
  ClientError,
  type ClientDataset,
  type ClientInvalidation,
  type ClientState,
  type ClientVersion,
} from "./contract.js";

/** Backend-owned lifecycle and committed-data publications. */
export class ClientSignals {
  private currentVersion: ClientVersion = Object.freeze({ generation: 0, revision: 0 });
  private currentState: ClientState;
  private readonly dataListeners = new Set<(event: ClientInvalidation) => void>();
  private readonly stateListeners = new Set<(state: ClientState) => void>();
  private disposed = false;
  constructor(
    state: ClientState,
    private readonly listenerError: (error: unknown) => void = () => {},
  ) {
    this.currentState = Object.freeze({ ...state });
  }
  get version(): ClientVersion {
    return this.currentVersion;
  }
  get state(): ClientState {
    return this.currentState;
  }
  subscribe(listener: (event: ClientInvalidation) => void): () => void {
    if (this.disposed) return () => {};
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }
  subscribeState(listener: (state: ClientState) => void): () => void {
    if (this.disposed) return () => {};
    this.stateListeners.add(listener);
    try {
      listener(this.currentState);
    } catch (error) {
      this.reportListenerError(error);
    }
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  transition(state: ClientState): void {
    this.assertActive();
    this.currentState = Object.freeze({ ...state });
    this.notify(this.stateListeners, this.currentState);
  }
  /** Call only after a successful committed write or an observed external change. */
  publish(
    datasets: readonly ClientDataset[],
    namespaceIds?: readonly string[],
    reset = false,
  ): ClientInvalidation {
    this.assertActive();
    if (datasets.length === 0 || namespaceIds?.length === 0)
      throw new ClientError("validation", "Invalidation targets must not be empty");
    this.currentVersion = Object.freeze(
      reset
        ? { generation: this.version.generation + 1, revision: 0 }
        : { generation: this.version.generation, revision: this.version.revision + 1 },
    );
    const event: ClientInvalidation = Object.freeze({
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
  private reportListenerError(error: unknown): void {
    try {
      this.listenerError(error);
    } catch {
      // Diagnostics must never interrupt committed-data or lifecycle delivery.
    }
  }
  private assertActive() {
    if (this.disposed) throw new ClientError("unavailable", "Backend is disposed");
  }
  private notify<T>(listeners: Set<(event: T) => void>, event: T) {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(event);
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }
}
