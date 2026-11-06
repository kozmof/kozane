import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  createDatabaseAdapter,
  createServiceContext,
  type DatabaseHandle,
} from "@kozane/core/database";
import * as schema from "@kozane/core/schema";
import { cards } from "@kozane/core/services";
import { verifiedBytes, verifiedModule, type AssetManifest } from "./verified-loader";
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
  private disposed = false;
  private closed = false;
  private probed = false;
  readonly db;
  constructor(
    bytes: ArrayBuffer,
    private readonly buildId: string,
    private readonly timeout: number,
    private readonly clock: ActiveClock,
    private readonly onDispose: () => void,
  ) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
    try {
      this.worker = new Worker(url, { type: "module" });
    } finally {
      URL.revokeObjectURL(url);
    }
    this.worker.onerror = () => this.dispose();
    this.worker.onmessageerror = () => this.dispose();
    this.worker.onmessage = ({ data }) => {
      if (!data || typeof data !== "object" || !Number.isSafeInteger(data.id)) {
        this.dispose();
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
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.onDispose();
  }
  private async rpc(method: string, extra = {}): Promise<any> {
    await this.clock.whenRunning();
    if (this.disposed) throw new HarnessFailure("unknown", "Worker is unavailable");
    return deadline(
      new Promise((resolve, reject) => {
        const id = ++this.sequence;
        this.pending.set(id, { resolve, reject });
        try {
          this.worker.postMessage({ id, method, ...extra });
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      }),
      method === "probe" ? 10_000 : this.timeout,
      () => this.dispose(),
      this.clock,
    );
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
    return {
      validate: (request) => this.queue.run(() => validateCandidate(this.db, request)),
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
  ) {
    validateDeadlineDuration(timeout);
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
      this.clock,
      () => this.clients.delete(client),
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
    this.module = await verifiedModule(
      {
        ...this.manifest,
        wasmUrl: new URL("./sqlite3.wasm", assetBase).href,
      },
      this.clock,
    );
    assertCurrent();
    this.assertActive();
    this.sampleBytes = new Uint8Array(
      await verifiedBytes(new URL("./sample.db", assetBase), this.manifest.sampleHash, this.clock),
    );
    assertCurrent();
    this.assertActive();
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
