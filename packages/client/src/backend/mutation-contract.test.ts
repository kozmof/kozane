import { describe, expect, it, vi } from "vitest";
import { cardResults } from "../../../kozane/src/test-utils/card-results.js";
import { inventoryResults } from "../../../kozane/src/test-utils/inventory-results.js";
import { geometryResults } from "../../../kozane/src/test-utils/geometry-results.js";
import { structureResults } from "../../../kozane/src/test-utils/structure-results.js";
import {
  HttpBackend,
  StaticBackend,
  type BackendInvalidation,
  type KozaneBackend,
} from "./index.js";

import {
  backendMutationCases as cases,
  type MutationName,
  type MutationCase,
} from "./testing/mutations.js";
const entries = Object.entries(cases) as [MutationName, MutationCase][];
const capabilities = {
  writable: true,
  taskspaces: false,
  persistent: true,
  externalWrites: false,
  auth: false,
};
const responses: Record<MutationName, unknown> = {
  ...structureResults,
  ...geometryResults,
  ...inventoryResults,
  ...cardResults,
};
const datasets = ["snapshot", "tags", "map", "namespaces", "warpDirectory"];

describe.each(entries)("%s mutation contract", (_name, operation) => {
  it("routes once and publishes the committed revision before resolving", async () => {
    let respond!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const backend = new HttpBackend({ capabilities, fetcher });
    const prior = backend.version;
    const events: BackendInvalidation[] = [];
    const unsubscribe = backend.subscribe((event) => {
      expect(backend.version).toEqual({ generation: event.generation, revision: event.revision });
      events.push(event);
    });
    const pending = operation.call(backend);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(operation.path);
    expect(request.method).toBe(operation.method);
    expect(request.body === undefined ? undefined : JSON.parse(String(request.body))).toEqual(
      operation.body,
    );
    expect(request.keepalive).toBe(operation.keepalive);
    expect(events).toEqual([]);
    expect(backend.version).toBe(prior);
    respond(Response.json(responses[_name]));
    await pending;
    expect(events).toEqual([{ generation: 0, revision: 1, datasets }]);
    expect(prior).toEqual({ generation: 0, revision: 0 });
    unsubscribe();
  });

  it("retains a domain rejection without invalidation or replay", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('{"message":"Operation refused"}', {
          status: 400,
          headers: { "X-Kozane-Error-Code": "conflict", "content-type": "application/json" },
        }),
    );
    const backend = new HttpBackend({ capabilities, fetcher });
    const events: BackendInvalidation[] = [];
    const unsubscribe = backend.subscribe((event) => events.push(event));
    await expect(operation.call(backend)).rejects.toMatchObject({
      code: "conflict",
      message: "Operation refused",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(backend.version).toEqual({ generation: 0, revision: 0 });
    unsubscribe();
  });

  it.each(["http", "static"])("rejects read-only %s calls without effects", async (kind) => {
    const fetcher = vi.fn();
    const backend: KozaneBackend =
      kind === "http"
        ? new HttpBackend({ capabilities: { ...capabilities, writable: false }, fetcher })
        : new StaticBackend({ namespaces: [] });
    const events: BackendInvalidation[] = [];
    const unsubscribe = backend.subscribe((event) => events.push(event));
    await expect(operation.call(backend)).rejects.toMatchObject({ code: "read_only" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(backend.version).toEqual({ generation: 0, revision: 0 });
    unsubscribe();
  });
});
