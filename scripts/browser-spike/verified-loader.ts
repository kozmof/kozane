import { deadline } from "./deadline";
export class AssetVerificationError extends Error {}
export interface AssetManifest {
  buildId: string;
  workerHash: string;
  wasmHash: string;
}

export async function verifiedBytes(url: URL, expectedHash: string): Promise<ArrayBuffer> {
  const controller = new AbortController();
  return deadline(
    (async () => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new AssetVerificationError("Asset fetch failed");
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== expectedHash) throw new AssetVerificationError("Asset integrity mismatch");
      return bytes;
    })(),
    30_000,
    () => controller.abort(),
  );
}

export async function verifiedWorker(manifest: AssetManifest): Promise<Worker> {
  const bytes = await verifiedBytes(new URL("./worker.js", location.href), manifest.workerHash);
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    return new Worker(url, { type: "module" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function verifiedModule(manifest: AssetManifest): Promise<WebAssembly.Module> {
  const controller = new AbortController();
  return deadline(
    (async () => {
      const response = await fetch(new URL("./sqlite3.wasm", location.href), {
        signal: controller.signal,
      });
      if (!response.ok) throw new AssetVerificationError("Asset fetch failed");
      const compilation = deadline(WebAssembly.compileStreaming(response.clone()), 30_000, () =>
        controller.abort(),
      );
      // Observe both branches even when integrity verification fails.
      const results = await Promise.allSettled([
        compilation,
        (async () => {
          const bytes = await response.arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const hash = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          if (hash !== manifest.wasmHash)
            throw new AssetVerificationError("Asset integrity mismatch");
        })(),
      ]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      return (results[0] as PromiseFulfilledResult<WebAssembly.Module>).value;
    })(),
    30_000,
    () => controller.abort(),
  );
}
