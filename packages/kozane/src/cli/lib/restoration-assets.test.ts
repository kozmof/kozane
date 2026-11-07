import { afterEach, expect, it, vi } from "vitest";
import { ActiveClock } from "../../../../../scripts/restoration-harness/active-clock";
import { webcrypto } from "node:crypto";
import {
  verifiedModule,
  AssetVerificationError,
} from "../../../../../scripts/restoration-harness/verified-loader";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("reports an integrity failure when malformed wasm also fails parallel compilation", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "application/wasm" },
        }),
    ),
  );
  await expect(
    verifiedModule({ buildId: "test", workerHash: "unused", wasmHash: "wrong" }),
  ).rejects.toBeInstanceOf(AssetVerificationError);
});
it("classifies a hash-matching invalid module as a build defect", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(bytes, { headers: { "Content-Type": "application/wasm" } })),
  );
  await expect(
    verifiedModule({ buildId: "test", workerHash: "unused", wasmHash: hash }),
  ).rejects.toBeInstanceOf(AssetVerificationError);
});
it("uses the explicit wasm asset URL independently of the current destination", async () => {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const fetcher = vi.fn(
    async () => new Response(bytes, { headers: { "Content-Type": "application/wasm" } }),
  );
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetcher);
  const url = "https://example.test/static/sqlite3.wasm";
  expect(
    await verifiedModule({ buildId: "test", workerHash: "unused", wasmHash: hash, wasmUrl: url }),
  ).toBeInstanceOf(WebAssembly.Module);
  expect(fetcher).toHaveBeenCalledWith(
    new URL(url),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it("retains both wasm deadlines during confirmed suspension and reconciles compilation on resume", async () => {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const module = await WebAssembly.compile(bytes);
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  let complete!: (module: WebAssembly.Module) => void;
  const compilation = new Promise<WebAssembly.Module>((resolve) => {
    complete = resolve;
  });
  const compile = vi.spyOn(WebAssembly, "compileStreaming").mockReturnValue(compilation);
  vi.stubGlobal("crypto", { subtle: { digest: async () => digest } });
  const fetcher = vi.fn(
    async (_url: URL, _options: { signal: AbortSignal }) =>
      new Response(bytes, { headers: { "Content-Type": "application/wasm" } }),
  );
  vi.stubGlobal("fetch", fetcher);
  vi.useFakeTimers();
  const active = new ActiveClock();
  let settled = false;
  const result = verifiedModule({ buildId: "test", workerHash: "unused", wasmHash: hash }, active);
  const observed = result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(compile).toHaveBeenCalledOnce();
    active.suspend("bfcache");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(settled).toBe(false);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
    complete(module);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    active.resume("bfcache");
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(module);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
  } finally {
    active.dispose();
    complete(module);
    await observed;
  }
});
