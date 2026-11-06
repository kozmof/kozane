import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  createDatabaseAdapter,
  createServiceContext,
  type DatabaseHandle,
} from "@kozane/core/database";
import * as schema from "@kozane/core/schema";
import { cards } from "@kozane/core/services";
import { verifiedBytes, verifiedModule, type AssetManifest } from "./verified-loader";
import { ResumeGate } from "./resume-gate";
import { ActiveClock } from "./active-clock";
import { trackSuspension } from "./suspension";
import { deadline, validateDeadlineDuration } from "./deadline";
import { OperationQueue } from "./operation-queue";
import { HarnessFailure, type Candidate } from "./recovery";
import { validateCandidate, type NamespaceView } from "./validation";
const assetBase = import.meta.url;
export interface HarnessManifest extends AssetManifest {
  sampleHash: string;
  sampleNamespaceId: string;
}
export interface WorkerCandidate extends Candidate<NamespaceView> {
  createCard(namespaceId: string, partitionId: string, content: string): Promise<unknown>;
  fixture(sql: string): Promise<void>;
}
class CandidateWorker {
  private readonly worker: Worker;
  private readonly queue = new OperationQueue();
  private readonly pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private sequence = 0;
  private readonly instanceId = crypto.randomUUID();
  private readonly databasePending = new Set<Promise<unknown>>();
  private readonly gate: ResumeGate;
  private readonly unresume: () => void;
  private readonly blobUrl: string;
  private disposed = false;
  private closed = false;
  private probed = false;
  readonly db;
  constructor(
    bytes: ArrayBuffer,
    private readonly buildId: string,
    private readonly timeout: number,
    private readonly healthTimeout: number,
    private readonly clock: ActiveClock,
    private readonly onDispose: () => void,
    private readonly failContext: (error: Error) => void,
  ) {
    this.blobUrl = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
    try {
      this.worker = new Worker(this.blobUrl, { type: "module" });
    } catch (error) {
      URL.revokeObjectURL(this.blobUrl);
      throw error;
    }
    this.gate = new ResumeGate({
      probe: async () => {
        if ((await this.healthRpc("probe")) !== this.buildId)
          throw new Error("Resume probe failed");
      },
      pendingDatabase: async () => {
        await Promise.allSettled([...this.databasePending]);
        if (this.disposed) throw new Error("Worker is unavailable");
      },
      connection: async () => {
        if ((await this.healthRpc("connection")) !== true)
          throw new Error("Resume connection check failed");
      },
      fail: () => this.failContext(new HarnessFailure("unknown", "Resume health check failed")),
    });
    this.unresume = this.clock.onResume(() => this.gate.resume());
    this.worker.onerror = () =>
      this.failContext(new HarnessFailure("unknown", "Worker execution failed"));
    this.worker.onmessageerror = () =>
      this.failContext(new HarnessFailure("unknown", "Worker response decoding failed"));
    this.worker.onmessage = ({ data }) => {
      if (
        !data ||
        typeof data !== "object" ||
        !Number.isSafeInteger(data.id) ||
        data.instanceId !== this.instanceId
      ) {
        this.failContext(new HarnessFailure("unknown", "Worker response identity failed"));
        return;
      }
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error) {
        const kind = ["database_content", "transient"].includes(data.error.kind)
          ? data.error.kind
          : "unknown";
        request.reject(new HarnessFailure(kind, "Candidate database operation failed"));
      } else request.resolve(data.result);
    };
    const handle = drizzle((sql, args, method) => this.rpc(method, { sql, args }), { schema });
    const transaction = async <T>(
      begin: string,
      operation: (handle: DatabaseHandle) => Promise<T>,
    ) => {
      await this.rpc("run", { sql: begin });
      try {
        const result = await operation(handle);
        await this.rpc("run", { sql: "COMMIT" });
        return result;
      } catch (error) {
        try {
          await this.rpc("run", { sql: "ROLLBACK" });
        } catch {
          throw new HarnessFailure("unknown", "Rollback failed");
        }
        throw error;
      }
    };
    this.db = createDatabaseAdapter(handle, {
      read: (operation) => transaction("BEGIN DEFERRED", operation),
      write: (operation) => transaction("BEGIN IMMEDIATE", operation),
    });
  }
  dispose(error: Error = new HarnessFailure("unknown", "Worker is unavailable")): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.dispose();
    this.worker.terminate();
    URL.revokeObjectURL(this.blobUrl);
    this.unresume();
    this.gate.dispose(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.onDispose();
  }
  private dispatch(method: string, extra: {}, milliseconds: number): Promise<any> {
    if (this.disposed) throw new HarnessFailure("unknown", "Worker is unavailable");
    return deadline(
      new Promise((resolve, reject) => {
        const id = ++this.sequence;
        this.pending.set(id, { resolve, reject });
        try {
          this.worker.postMessage({ ...extra, id, instanceId: this.instanceId, method });
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      }),
      milliseconds,
      () => this.dispose(),
      this.clock,
    );
  }
  private async healthRpc(method: "probe" | "connection"): Promise<any> {
    await this.clock.whenRunning();
    return this.dispatch(method, {}, this.healthTimeout);
  }
  private async rpc(method: string, extra = {}): Promise<any> {
    while (true) {
      await this.clock.whenRunning();
      await this.gate.before(method);
      this.clock.check();
      if (!this.clock.running || !this.gate.canDispatch(method)) continue;
      const result = this.dispatch(method, extra, method === "probe" ? 10_000 : this.timeout).then(
        (value) => {
          if (method === "open") this.gate.opened();
          if (method === "close") this.gate.closed();
          return value;
        },
      );
      if (method === "probe" || method === "initialize") return result;
      const tracked = result.finally(() => this.databasePending.delete(tracked));
      this.databasePending.add(tracked);
      return tracked;
    }
  }
  isResponsive(): boolean {
    return !this.disposed && this.gate.canDispatch("initialize");
  }
  async responsive(): Promise<void> {
    while (true) {
      await this.clock.whenRunning();
      await this.gate.before("initialize");
      this.clock.check();
      if (this.clock.running && this.gate.canDispatch("initialize")) return;
    }
  }
  isReady(): boolean {
    return !this.disposed && this.gate.canPublish();
  }
  async ready(): Promise<void> {
    while (true) {
      await this.clock.whenRunning();
      await this.gate.readyForPublication();
      this.clock.check();
      if (this.clock.running && this.gate.canPublish()) return;
    }
  }
  async probe(): Promise<void> {
    if (this.probed) return;
    if ((await this.rpc("probe")) !== this.buildId)
      throw new HarnessFailure("asset", "Worker build mismatch");
    this.probed = true;
  }
  async open(module: WebAssembly.Module, bytes: Uint8Array): Promise<WorkerCandidate> {
    await this.probe();
    await this.rpc("initialize", { module });
    await this.rpc("open", { bytes });
    await this.ready();
    return {
      validate: (request) =>
        this.queue.run(async () => {
          const view = await validateCandidate(this.db, request);
          await this.ready();
          return view;
        }),
      createCard: (namespaceId, partitionId, content) =>
        this.queue.run(() =>
          cards.create(this.db, createServiceContext(), namespaceId, { partitionId, content }),
        ),
      fixture: (sql) =>
        this.queue.run(async () => {
          await this.rpc("run", { sql });
        }),
      close: async () => {
        if (this.closed) return;
        this.closed = true;
        try {
          await this.queue.run(async () => {
            await this.rpc("close");
          });
        } finally {
          this.dispose();
        }
      },
    };
  }
}
/** Cache verified original assets for one root lifetime. Each candidate owns an independent worker. */
export class WorkerContext {
  private readonly clients = new Set<CandidateWorker>();
  private bootstrap: CandidateWorker | undefined;
  private workerBytes: ArrayBuffer | undefined;
  private module: WebAssembly.Module | undefined;
  private sampleBytes: Uint8Array | undefined;
  private disposed = false;
  readonly clock: ActiveClock;
  private readonly untrack: () => void;
  constructor(
    readonly manifest: HarnessManifest,
    private readonly timeout = 30_000,
    private readonly healthTimeout = 10_000,
  ) {
    validateDeadlineDuration(timeout);
    validateDeadlineDuration(healthTimeout);
    this.clock = new ActiveClock();
    this.clock.onFailure((error) => this.dispose(error));
    this.untrack = trackSuspension(this.clock);
  }
  private assertActive(): void {
    if (this.disposed) throw new HarnessFailure("unknown", "Worker context is closed");
  }
  private create(): CandidateWorker {
    this.assertActive();
    if (!this.workerBytes) throw new Error("Worker assets are not loaded");
    const client = new CandidateWorker(
      this.workerBytes,
      this.manifest.buildId,
      this.timeout,
      this.healthTimeout,
      this.clock,
      () => this.clients.delete(client),
      (error) => this.dispose(error),
    );
    this.clients.add(client);
    return client;
  }
  async load(assertCurrent: () => void = () => {}): Promise<void> {
    this.workerBytes = await verifiedBytes(
      new URL("./worker.js", assetBase),
      this.manifest.workerHash,
      this.clock,
    );
    assertCurrent();
    this.assertActive();
    this.bootstrap = this.create();
    await this.bootstrap.probe();
    await this.responsive();
    this.module = await verifiedModule(
      {
        ...this.manifest,
        wasmUrl: new URL("./sqlite3.wasm", assetBase).href,
      },
      this.clock,
    );
    assertCurrent();
    this.assertActive();
    await this.responsive();
    this.sampleBytes = new Uint8Array(
      await verifiedBytes(new URL("./sample.db", assetBase), this.manifest.sampleHash, this.clock),
    );
    assertCurrent();
    this.assertActive();
    await this.responsive();
  }
  private async responsive(): Promise<void> {
    while (true) {
      await this.clock.whenRunning();
      await Promise.all([...this.clients].map((client) => client.responsive()));
      this.assertActive();
      this.clock.check();
      if (this.clock.running && [...this.clients].every((client) => client.isResponsive())) return;
    }
  }
  isReady(): boolean {
    this.clock.check();
    return (
      !this.disposed && this.clock.running && [...this.clients].every((client) => client.isReady())
    );
  }
  async ready(): Promise<void> {
    while (true) {
      await this.clock.whenRunning();
      await Promise.all([...this.clients].map((client) => client.ready()));
      this.assertActive();
      if (this.isReady()) return;
    }
  }
  sample(): { bytes: Uint8Array; namespaceId: string } {
    this.assertActive();
    if (!this.sampleBytes) throw new Error("Sample assets are not loaded");
    return { bytes: this.sampleBytes, namespaceId: this.manifest.sampleNamespaceId };
  }
  async open(bytes: Uint8Array): Promise<WorkerCandidate> {
    this.assertActive();
    if (!this.module) throw new Error("Wasm assets are not loaded");
    const client = this.bootstrap ?? this.create();
    this.bootstrap = undefined;
    try {
      return await client.open(this.module, bytes);
    } catch (error) {
      client.dispose();
      throw error;
    }
  }
  get liveWorkers(): number {
    return this.clients.size;
  }
  dispose(error?: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const client of [...this.clients]) client.dispose(error);
    this.bootstrap = undefined;
    this.untrack();
    this.clock.dispose(error);
  }
}
