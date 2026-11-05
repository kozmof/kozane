import { describe, expect, it, vi } from "vitest";
import { cardResults } from "../../test-utils/card-results.js";
import { inventoryResults } from "../../test-utils/inventory-results.js";
import { geometryResults } from "../../test-utils/geometry-results.js";
import { structureResults } from "../../test-utils/structure-results.js";
import {
  HttpBackend,
  StaticBackend,
  type BackendInvalidation,
  type KozaneBackend,
} from "./index.js";

type MutationResource = Pick<
  KozaneBackend,
  "cards" | "glues" | "layers" | "partitions" | "scopes" | "warps" | "inventories"
>;
type MutationName =
  | {
      [R in keyof MutationResource]: `${R}.${keyof MutationResource[R] & string}`;
    }[keyof MutationResource]
  | "namespaces.create";
interface MutationCase {
  call: (backend: KozaneBackend) => Promise<unknown>;
  method: string;
  path: string;
  body?: unknown;
  keepalive: boolean;
}
// A new domain mutation requires a case before the project can type-check.
const cases = {
  "cards.create": {
    call: (b) => b.cards.create("n /", { partitionId: "p", content: "Text" }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/cards",
    body: { partitionId: "p", content: "Text" },
    keepalive: true,
  },
  "cards.update": {
    call: (b) => b.cards.update("n /", "c", { width: null }, { keepalive: true }),
    method: "PATCH",
    path: "/n%20%2F/api/cards/c",
    body: { width: null },
    keepalive: true,
  },
  "cards.updatePositions": {
    call: (b) =>
      b.cards.updatePositions(
        "n /",
        { positions: [{ cardId: "c", posX: 1, posY: 2 }] },
        { keepalive: true },
      ),
    method: "PATCH",
    path: "/n%20%2F/api/cards",
    body: { positions: [{ cardId: "c", posX: 1, posY: 2 }] },
    keepalive: true,
  },
  "cards.remove": {
    call: (b) => b.cards.remove("n /", { cardIds: ["c"] }),
    method: "DELETE",
    path: "/n%20%2F/api/cards",
    body: { cardIds: ["c"] },
    keepalive: false,
  },
  "cards.removeOne": {
    call: (b) => b.cards.removeOne("n /", "c"),
    method: "DELETE",
    path: "/n%20%2F/api/cards/c",
    keepalive: false,
  },
  "cards.move": {
    call: (b) => b.cards.move("n /", { cardIds: ["c"], targetNamespaceId: "other" }),
    method: "POST",
    path: "/n%20%2F/api/cards/move",
    body: { cardIds: ["c"], targetNamespaceId: "other" },
    keepalive: false,
  },
  "cards.setLayer": {
    call: (b) => b.cards.setLayer("n /", { cardIds: ["c"], layerId: "l" }),
    method: "PATCH",
    path: "/n%20%2F/api/cards/layer",
    body: { cardIds: ["c"], layerId: "l" },
    keepalive: false,
  },
  "cards.setPartition": {
    call: (b) => b.cards.setPartition("n /", { cardIds: ["c"], partitionId: "p" }),
    method: "PATCH",
    path: "/n%20%2F/api/cards/partition",
    body: { cardIds: ["c"], partitionId: "p" },
    keepalive: false,
  },
  "cards.setStacking": {
    call: (b) => b.cards.setStacking("n /", { cardIds: ["c"], direction: "front" }),
    method: "PATCH",
    path: "/n%20%2F/api/cards/stacking",
    body: { cardIds: ["c"], direction: "front" },
    keepalive: false,
  },
  "cards.squash": {
    call: (b) => b.cards.squash("n /", { cardId: "c" }),
    method: "POST",
    path: "/n%20%2F/api/cards/squash",
    body: { cardId: "c" },
    keepalive: false,
  },
  "glues.create": {
    call: (b) => b.glues.create("n /", { cardIds: ["c", "d"] }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/glues",
    body: { cardIds: ["c", "d"] },
    keepalive: true,
  },
  "glues.remove": {
    call: (b) => b.glues.remove("n /", { cardIds: ["c"] }, { keepalive: true }),
    method: "DELETE",
    path: "/n%20%2F/api/glues",
    body: { cardIds: ["c"] },
    keepalive: true,
  },
  "layers.create": {
    call: (b) => b.layers.create("n /", { name: "Layer" }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/layers",
    body: { name: "Layer" },
    keepalive: true,
  },
  "layers.rename": {
    call: (b) => b.layers.rename("n /", "l", { name: "Layer" }, { keepalive: true }),
    method: "PATCH",
    path: "/n%20%2F/api/layers/l",
    body: { name: "Layer" },
    keepalive: true,
  },
  "layers.remove": {
    call: (b) => b.layers.remove("n /", "l", { keepalive: true }),
    method: "DELETE",
    path: "/n%20%2F/api/layers/l",
    keepalive: false,
  },
  "layers.reorder": {
    call: (b) => b.layers.reorder("n /", { layerIds: ["l"] }, { keepalive: true }),
    method: "PATCH",
    path: "/n%20%2F/api/layers",
    body: { layerIds: ["l"] },
    keepalive: true,
  },
  "partitions.create": {
    call: (b) => b.partitions.create("n /", { name: "Partition" }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/partitions",
    body: { name: "Partition" },
    keepalive: true,
  },
  "partitions.rename": {
    call: (b) => b.partitions.rename("n /", "p", { name: "Partition" }, { keepalive: true }),
    method: "PATCH",
    path: "/n%20%2F/api/partitions/p",
    body: { name: "Partition" },
    keepalive: true,
  },
  "partitions.remove": {
    call: (b) => b.partitions.remove("n /", "p", { keepalive: true }),
    method: "DELETE",
    path: "/n%20%2F/api/partitions/p",
    keepalive: false,
  },
  "scopes.create": {
    call: (b) => b.scopes.create("n /", { name: "Scope" }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/scopes",
    body: { name: "Scope" },
    keepalive: true,
  },
  "scopes.rename": {
    call: (b) => b.scopes.rename("n /", "s", { name: "Scope" }, { keepalive: true }),
    method: "PATCH",
    path: "/n%20%2F/api/scopes/s",
    body: { name: "Scope" },
    keepalive: true,
  },
  "scopes.remove": {
    call: (b) => b.scopes.remove("n /", "s", { keepalive: true }),
    method: "DELETE",
    path: "/n%20%2F/api/scopes/s",
    keepalive: false,
  },
  "scopes.addMembers": {
    call: (b) => b.scopes.addMembers("n /", "s", { cardIds: ["c"] }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/scopes/s/members",
    body: { cardIds: ["c"] },
    keepalive: true,
  },
  "scopes.removeMembers": {
    call: (b) => b.scopes.removeMembers("n /", "s", { cardIds: ["c"] }, { keepalive: true }),
    method: "DELETE",
    path: "/n%20%2F/api/scopes/s/members",
    body: { cardIds: ["c"] },
    keepalive: true,
  },
  "scopes.createArea": {
    call: (b) =>
      b.scopes.createArea(
        "n /",
        "s",
        { posX: 1, posY: 2, width: 30, height: 40 },
        { keepalive: true },
      ),
    method: "POST",
    path: "/n%20%2F/api/scopes/s/areas",
    body: { posX: 1, posY: 2, width: 30, height: 40 },
    keepalive: true,
  },
  "scopes.updateArea": {
    call: (b) =>
      b.scopes.updateArea(
        "n /",
        "s",
        "a",
        { posX: 1, posY: 2, width: 30, height: 40 },
        { keepalive: true },
      ),
    method: "PATCH",
    path: "/n%20%2F/api/scopes/s/areas/a",
    body: { posX: 1, posY: 2, width: 30, height: 40 },
    keepalive: true,
  },
  "scopes.removeArea": {
    call: (b) => b.scopes.removeArea("n /", "s", "a", { keepalive: true }),
    method: "DELETE",
    path: "/n%20%2F/api/scopes/s/areas/a",
    keepalive: false,
  },
  "warps.create": {
    call: (b) => b.warps.create("n /", { posX: 1, posY: 2 }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/warps",
    body: { posX: 1, posY: 2 },
    keepalive: true,
  },
  "warps.update": {
    call: (b) => b.warps.update("n /", "w", { posX: 1, posY: 2 }, { keepalive: true }),
    method: "PATCH",
    path: "/n%20%2F/api/warps/w",
    body: { posX: 1, posY: 2 },
    keepalive: true,
  },
  "warps.remove": {
    call: (b) => b.warps.remove("n /", "w", { keepalive: true }),
    method: "DELETE",
    path: "/n%20%2F/api/warps/w",
    keepalive: false,
  },
  "inventories.create": {
    call: (b) => b.inventories.create("n /", { posX: 1, posY: 2 }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/inventories",
    body: { posX: 1, posY: 2 },
    keepalive: true,
  },
  "inventories.update": {
    call: (b) => b.inventories.update("n /", "i", { name: "Tray" }, { keepalive: true }),
    method: "PATCH",
    path: "/n%20%2F/api/inventories/i",
    body: { name: "Tray" },
    keepalive: true,
  },
  "inventories.remove": {
    call: (b) => b.inventories.remove("n /", "i", { keepalive: true }),
    method: "DELETE",
    path: "/n%20%2F/api/inventories/i",
    keepalive: false,
  },
  "inventories.stow": {
    call: (b) => b.inventories.stow("n /", "i", { cardIds: ["c"] }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/inventories/i/cards",
    body: { cardIds: ["c"] },
    keepalive: true,
  },
  "inventories.take": {
    call: (b) => b.inventories.take("n /", { cards: [{ cardId: "c" }] }, { keepalive: true }),
    method: "POST",
    path: "/n%20%2F/api/inventories/take",
    body: { cards: [{ cardId: "c" }] },
    keepalive: true,
  },
  "namespaces.create": {
    call: (b) => b.namespaces.create({ name: "Namespace" }),
    method: "POST",
    path: "/api/namespaces",
    body: { name: "Namespace" },
    keepalive: false,
  },
} satisfies Record<MutationName, MutationCase>;
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
