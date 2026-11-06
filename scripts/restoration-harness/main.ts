import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createDatabaseAdapter } from "@kozane/core/database";
import { schemaVersion } from "@kozane/core/migrations";
import * as schema from "@kozane/core/schema";
import {
  verifiedBytes,
  verifiedWorker,
  verifiedModule,
  AssetVerificationError,
  type AssetManifest,
} from "./verified-loader";
import { DestinationTracker } from "./navigation";
import { deadline } from "./deadline";
import { OperationQueue } from "./operation-queue";
import { restoreCandidate, HarnessFailure, type Candidate } from "./recovery";
import { validateCandidate, type NamespaceView } from "./validation";
declare const __RESTORATION_MANIFEST__: AssetManifest & {
  sampleHash: string;
  sampleNamespaceId: string;
};
const manifest = __RESTORATION_MANIFEST__;
async function run(
  namespaceId?: string,
  controls: {
    navigation?: DestinationTracker;
    rpcTimeoutMs?: number;
    beforeView?: (namespaceId?: string) => Promise<void>;
  } = {},
) {
  let worker: Worker | undefined;
  let sequence = 0;
  let unavailable = false;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const queue = new OperationQueue();
  function terminate(error = new HarnessFailure("unknown", "Worker is unavailable")) {
    unavailable = true;
    queue.dispose();
    worker?.terminate();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  async function rpc(method: string, extra = {}): Promise<any> {
    if (unavailable) throw new HarnessFailure("unknown", "Worker is unavailable");
    return deadline(
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        try {
          worker!.postMessage({ id, method, ...extra });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      }),
      method === "probe" ? 10_000 : (controls.rpcTimeoutMs ?? 30_000),
      () => terminate(),
    );
  }
  try {
    worker = await verifiedWorker(manifest);
    worker.onerror = () => terminate();
    worker.onmessageerror = () => terminate();
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.error) {
        const kind = ["database_content", "transient"].includes(data.error.kind)
          ? data.error.kind
          : "unknown";
        request.reject(new HarnessFailure(kind, "Candidate database operation failed"));
      } else request.resolve(data.result);
    };
    if ((await rpc("probe")) !== manifest.buildId)
      throw new HarnessFailure("asset", "Worker build mismatch");
    await rpc("initialize", { module: await verifiedModule(manifest) });
    const sampleBytes = new Uint8Array(
      await verifiedBytes(new URL("./sample.db", location.href), manifest.sampleHash),
    );
    const handle = drizzle((sql, args, method) => rpc(method, { sql, args }), { schema });
    const db = createDatabaseAdapter(handle, {
      read: async (operation) => {
        await rpc("run", { sql: "BEGIN DEFERRED" });
        try {
          const result = await operation(handle);
          await rpc("run", { sql: "COMMIT" });
          return result;
        } catch (error) {
          try {
            await rpc("run", { sql: "ROLLBACK" });
          } catch {
            throw new HarnessFailure("unknown", "Rollback failed");
          }
          throw error;
        }
      },
      write: async () => {
        throw new Error("Restoration harness does not migrate or edit candidates");
      },
    });
    const result = await restoreCandidate<NamespaceView>({
      schemaVersion,
      namespaceId,
      navigation: controls.navigation,
      beforeView: controls.beforeView,
      storage: () => sessionStorage,
      sample: async () => ({ bytes: sampleBytes, namespaceId: manifest.sampleNamespaceId }),
      open: async (bytes) => {
        try {
          await rpc("open", { bytes });
        } catch (error) {
          try {
            await rpc("close");
          } catch {
            throw new HarnessFailure("unknown", "Candidate cleanup failed");
          }
          throw error;
        }
        const candidate: Candidate<NamespaceView> = {
          validate: (request) => queue.run(() => validateCandidate(db, request)),
          close: () => queue.run(() => rpc("close")),
        };
        return candidate;
      },
    });
    if (result.status === "ready") {
      const { candidate, ...report } = result;
      await candidate.close();
      return report;
    }
    return result;
  } catch (error) {
    const failure =
      error instanceof AssetVerificationError
        ? new HarnessFailure("asset", "Build asset verification failed")
        : error;
    return {
      status: "unavailable",
      action: failure instanceof HarnessFailure && failure.kind === "asset" ? "reload" : "retry",
      kind: failure instanceof HarnessFailure ? failure.kind : "unknown",
    };
  } finally {
    terminate();
  }
}
function start(namespaceId?: string, beforeView?: (namespaceId?: string) => Promise<void>) {
  const navigation = new DestinationTracker(namespaceId);
  return {
    navigate: (id?: string) => navigation.select(id),
    result: run(namespaceId, { navigation, beforeView }),
  };
}
Object.assign(window, { restorationHarness: { run, start, manifest, schemaVersion } });
document.body.dataset.harness = "ready";
