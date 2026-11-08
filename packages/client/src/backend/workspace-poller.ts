export interface PollLifecycle {
  visible(): boolean;
  listen(refresh: () => void): () => void;
}
export function browserPollLifecycle(): PollLifecycle {
  const environment = globalThis as typeof globalThis & {
    document?: EventTarget & { visibilityState: string };
    window?: EventTarget;
  };
  return {
    visible: () => environment.document?.visibilityState === "visible",
    listen(refresh) {
      if (!environment.window || !environment.document) return () => {};
      environment.window.addEventListener("focus", refresh);
      environment.document.addEventListener("visibilitychange", refresh);
      return () => {
        environment.window?.removeEventListener("focus", refresh);
        environment.document?.removeEventListener("visibilitychange", refresh);
      };
    },
  };
}
interface Session {
  baseline?: string;
  refreshRequired?: boolean;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  stop: () => void;
}
/** One polling session per nonempty data-subscriber lifetime. No mutation is retained. */
export class WorkspacePoller {
  private subscribers = 0;
  private disposed = false;
  private session?: Session;
  constructor(
    private readonly options: {
      lifecycle: PollLifecycle;
      initialDelayMs?: number;
      token: () => Promise<string>;
      throttleMs: () => number;
      changed: () => void;
      filesystemRefresh: () => void;
      failed?: (error: unknown) => void;
      succeeded?: () => void;
    },
  ) {}
  dispose(): void {
    this.disposed = true;
    this.stop();
  }
  retain(): () => void {
    if (this.disposed) return () => {};
    this.subscribers++;
    if (this.session) {
      if (this.session.refreshRequired) this.refresh(this.session);
    } else {
      const session: Session = { running: false, stop: () => {} };
      this.session = session;
      session.stop = this.options.lifecycle.listen(() => this.refresh(session));
      if ((this.options.initialDelayMs ?? 0) > 0)
        session.timer = setTimeout(() => this.refresh(session), this.options.initialDelayMs);
      else this.refresh(session);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.subscribers === 0) this.stop();
    };
  }
  private stop() {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    session.stop();
    if (session.timer !== undefined) clearTimeout(session.timer);
  }
  private refresh(session: Session): void {
    if (this.session !== session) return;
    if (session.timer !== undefined) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (!this.options.lifecycle.visible() || session.running) return;
    const wait = this.options.throttleMs();
    if (wait > 0) {
      session.timer = setTimeout(() => this.refresh(session), wait);
      return;
    }
    session.running = true;
    void this.options
      .token()
      .then((token) => {
        if (this.session !== session) return;
        const changed =
          session.refreshRequired || session.baseline === undefined || token !== session.baseline;
        session.baseline = token;
        session.refreshRequired = false;
        if (changed) this.options.changed();
        else this.options.filesystemRefresh();
        this.options.succeeded?.();
      })
      .catch((error: unknown) => {
        // Retain the last successful baseline and data. Recovery must revalidate all
        // datasets even when the next successful token equals that baseline.
        if (this.session === session) {
          session.refreshRequired = true;
          this.options.failed?.(error);
        }
      })
      .finally(() => {
        session.running = false;
        if (this.session === session && this.options.lifecycle.visible())
          session.timer = setTimeout(
            () => this.refresh(session),
            Math.max(1000, this.options.throttleMs()),
          );
      });
  }
}
