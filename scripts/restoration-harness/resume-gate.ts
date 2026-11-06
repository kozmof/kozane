export interface ResumeHooks {
  probe(): Promise<void>;
  pendingDatabase(): Promise<void>;
  connection(): Promise<void>;
  fail(error: unknown): void;
}
/** Health checks bypass the service queue. Dispatched operations retain their original deadlines. */
export class ResumeGate {
  private epoch = 0;
  private responsive = 0;
  private connected = 0;
  private handle = false;
  private probing: Promise<void> | undefined;
  private connecting: Promise<void> | undefined;
  private failure: unknown;
  private failed = false;
  private readonly waiters = new Set<{
    database: boolean;
    resolve(): void;
    reject(error: unknown): void;
  }>();
  constructor(private readonly hooks: ResumeHooks) {}
  resume(): void {
    if (this.failed) return;
    this.epoch++;
    this.startProbe();
  }
  opened(): void {
    this.handle = true;
    this.startConnection();
    this.release();
  }
  closed(): void {
    this.handle = false;
    this.release();
  }
  canDispatch(method: string): boolean {
    if (this.failed) throw this.failure;
    if (method === "probe" || method === "initialize" || method === "open")
      return this.responsive === this.epoch;
    return this.handle && this.connected === this.epoch;
  }
  before(method: string): Promise<void> {
    if (this.failed) return Promise.reject(this.failure);
    const database = method !== "probe" && method !== "initialize" && method !== "open";
    if (this.ready(database)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.waiters.add({ database, resolve, reject });
    });
  }
  canPublish(): boolean {
    return !this.failed && this.ready(this.handle);
  }
  readyForPublication(): Promise<void> {
    return this.before(this.handle ? "run" : "initialize");
  }
  private ready(database: boolean): boolean {
    return (
      this.responsive === this.epoch &&
      (!database || (this.handle && this.connected === this.epoch))
    );
  }
  private release(): void {
    for (const waiter of this.waiters)
      if (this.ready(waiter.database)) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
  }
  private fail(error: unknown): void {
    if (this.failed) return;
    this.dispose(error);
    this.hooks.fail(error);
  }
  private startProbe(): void {
    if (this.failed || this.probing || this.responsive === this.epoch) return;
    this.probing = (async () => {
      while (!this.failed && this.responsive < this.epoch) {
        const epoch = this.epoch;
        await this.hooks.probe();
        if (this.failed) return;
        this.responsive = epoch;
        this.release();
      }
    })()
      .catch((error) => this.fail(error))
      .finally(() => {
        this.probing = undefined;
        if (!this.failed) {
          this.startProbe();
          this.startConnection();
        }
      });
  }
  private startConnection(): void {
    if (
      this.failed ||
      !this.handle ||
      this.connecting ||
      this.responsive !== this.epoch ||
      this.connected === this.epoch
    )
      return;
    this.connecting = (async () => {
      const epoch = this.epoch;
      await this.hooks.pendingDatabase();
      if (this.failed || !this.handle || epoch !== this.epoch || this.responsive !== epoch) return;
      await this.hooks.connection();
      if (this.failed) return;
      if (this.handle && epoch === this.epoch && this.responsive === epoch) {
        this.connected = epoch;
        this.release();
      }
    })()
      .catch((error) => this.fail(error))
      .finally(() => {
        this.connecting = undefined;
        if (!this.failed) this.startConnection();
      });
  }
  dispose(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = error;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }
}
