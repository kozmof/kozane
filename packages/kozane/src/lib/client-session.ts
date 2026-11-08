import {
  ClientError,
  HttpClient,
  StaticClient,
  type ClientCapabilities,
  type ManagedClient,
  type StaticClientData,
} from "@kozane/client";

export interface PageClientSelection {
  clientCapabilities?: ClientCapabilities;
  staticClientData?: StaticClientData;
  readonly?: boolean;
}

/** One owner per root layout, never a module-global client or SSR singleton. */
export class WorkspaceClientSession {
  private active?: ManagedClient;
  private key?: string | object;
  private initialPage?: PageClientSelection;
  private release?: () => void;
  private disposed = false;
  private selecting = false;
  constructor(
    private readonly options: { base: string; fetcher?: typeof fetch; observeChanges?: boolean },
  ) {}

  select(data: PageClientSelection, fallback: () => StaticClientData): ManagedClient;
  select(data: PageClientSelection): ManagedClient | undefined;
  select(data: PageClientSelection, fallback?: () => StaticClientData): ManagedClient | undefined {
    if (this.selecting)
      throw new ClientError("unavailable", "Workspace selection is already in progress");
    if (this.disposed) throw new ClientError("unavailable", "Workspace session is disposed");
    const embedded =
      data.staticClientData ??
      (data.readonly && !data.clientCapabilities ? fallback?.() : undefined);
    let key: string | object;
    let create: () => ManagedClient;
    if (embedded) {
      key = data.staticClientData ?? data;
      create = () => new StaticClient(embedded);
    } else {
      const capabilities =
        data.clientCapabilities ??
        (fallback
          ? {
              writable: !data.readonly,
              persistent: true,
              taskspaces: true,
              externalWrites: true,
              auth: false,
            }
          : undefined);
      if (!capabilities) return undefined;
      key = JSON.stringify([
        capabilities.writable,
        capabilities.persistent,
        capabilities.taskspaces,
        capabilities.externalWrites,
        capabilities.auth,
      ]);
      create = () =>
        new HttpClient({
          base: this.options.base,
          fetcher: this.options.fetcher,
          capabilities,
          pollingInitialDelayMs: 1000,
        });
    }
    if (this.active && this.key === key) {
      if (this.initialPage !== data) this.initialPage = undefined;
      return this.active;
    }
    // Construct first so invalid embedded data cannot destroy a working session.
    const next = create();
    this.selecting = true;
    try {
      this.closeActive();
      if (this.disposed) {
        next.dispose();
        throw new ClientError("unavailable", "Workspace session is disposed");
      }
      this.active = next;
      this.initialPage = data;
      this.key = key;
      if (next.kind === "http" && this.options.observeChanges)
        this.release = next.subscribe(() => {});
      return next;
    } finally {
      this.selecting = false;
    }
  }

  /** Only the first unmodified HTTP seed belongs to a fresh connection. */
  trustsInitialSeed(data: PageClientSelection): boolean {
    return (
      !this.disposed &&
      this.active?.kind === "http" &&
      this.initialPage === data &&
      this.active.version.revision === 0
    );
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeActive();
  }
  private closeActive(): void {
    const release = this.release;
    const previous = this.active;
    this.release = undefined;
    this.active = undefined;
    this.key = undefined;
    this.initialPage = undefined;
    release?.();
    previous?.dispose();
  }
}
