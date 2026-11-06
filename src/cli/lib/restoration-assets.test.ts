import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import {
  verifiedModule,
  AssetVerificationError,
} from "../../../scripts/browser-spike/verified-loader";
afterEach(() => vi.unstubAllGlobals());
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
