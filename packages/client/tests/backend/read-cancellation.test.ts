import { expect, it, vi } from "vitest";
import type { KozaneClient, ReadOptions } from "../../src/backend/contract.js";
import { HttpClient } from "../../src/backend/http-client.js";
import { StaticClient } from "../../src/backend/static-client.js";
const capabilities = {
  writable: true,
  persistent: true,
  externalWrites: false,
  taskspaces: true,
  auth: false,
};
const reads: [string, (client: KozaneClient, options: ReadOptions) => Promise<unknown>][] = [
  ["snapshot", (c, o) => c.snapshot("ns", o)],
  ["namespaces.list", (c, o) => c.namespaces.list(o)],
  ["namespaces.get", (c, o) => c.namespaces.get("ns", o)],
  ["tags", (c, o) => c.tags.get(undefined, o)],
  ["map", (c, o) => c.map.get(o)],
  ["warp directory", (c, o) => c.warpDirectory.get("ns", o)],
  ["files", (c, o) => c.taskspaces!.readFile("ns", "task", "notes.md", o)],
  ["directory", (c, o) => c.taskspaces!.list("ns", "task", "", o)],
];
for (const [name, read] of reads) {
  it(`rejects pre-cancelled ${name} reads without HTTP I/O or invalidations`, async () => {
    const fetcher = vi.fn();
    const http = new HttpClient({ fetcher, capabilities });
    const embedded = new StaticClient({
      namespaces: [{ id: "ns", name: "N", isDefault: true }],
      files: {},
    });
    const controller = new AbortController();
    const reason = new DOMException("Navigation changed", "AbortError");
    controller.abort(reason);
    for (const client of [http, embedded]) {
      const events = vi.fn();
      client.subscribe(events);
      await expect(read(client, { signal: controller.signal })).rejects.toBe(reason);
      expect(events).not.toHaveBeenCalled();
      expect(client.version).toEqual({ generation: 0, revision: 0 });
      client.dispose();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it(`forwards in-flight cancellation for ${name} without classifying it as a network failure`, async () => {
    let actual: AbortSignal | undefined;
    const fetcher = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          actual = init?.signal ?? undefined;
          actual?.addEventListener("abort", () => reject(actual?.reason), { once: true });
        }),
    );
    const client = new HttpClient({ fetcher: fetcher as typeof fetch, capabilities });
    const controller = new AbortController();
    const pending = read(client, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(actual?.aborted).toBe(true);
    expect(client.state.status).toBe("ready");
    client.dispose();
  });
}
it("cancels while a response body is being decoded and leaves the client reusable", async () => {
  let finish!: (value: unknown) => void;
  const response = new Response();
  vi.spyOn(response, "json").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = new HttpClient({ fetcher: vi.fn().mockResolvedValue(response), capabilities });
  const controller = new AbortController();
  const pending = client.namespaces.list({ signal: controller.signal });
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  finish([]);
  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(client.state.status).toBe("ready");
  client.dispose();
});
