import { expect, it } from "vitest";
import {
  BackendError,
  HttpBackend,
  StaticBackend,
  type KozaneBackend,
  type SnapshotData,
  type CardCreateInput,
  type MutationOptions,
} from "./index.js";
const namespace = { id: "ns", name: "Namespace", isDefault: true };
const data: SnapshotData = {
  namespace: { id: "ns" },
  cards: [],
  partitions: [],
  layers: [],
  warps: [],
  inventories: [],
  scopes: [],
  scopeRels: [],
  scopeAreas: [],
  glueRels: [],
  taskspaces: [],
};
const adapters: [string, () => KozaneBackend][] = [
  ["static", () => new StaticBackend({ namespaces: [namespace], snapshots: [data] })],
  [
    "http",
    () =>
      new HttpBackend({
        capabilities: {
          writable: false,
          persistent: true,
          taskspaces: false,
          externalWrites: false,
          auth: false,
        },
        fetcher: async (input) => {
          const path = String(input);
          if (path === "/api/namespaces") return new Response(JSON.stringify([namespace]));
          if (path === "/api/namespaces/ns") return new Response(JSON.stringify(namespace));
          if (path === "/ns/api/snapshot") return new Response(JSON.stringify(data));
          return new Response('{"message":"Namespace not found"}', {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        },
      }),
  ],
];
it.each(adapters)(
  "supports an implementation-independent consumer through the entry module (%s)",
  async (_name, create) => {
    const backend: KozaneBackend = create();
    const observed: string[] = [];
    const release = backend.subscribeState((state) => observed.push(state.status));
    expect(observed).toEqual(["ready"]);
    const changes: unknown[] = [];
    const unsubscribe = backend.subscribe((event) => changes.push(event));
    const version = backend.version;
    expect(await backend.namespaces.list()).toEqual([namespace]);
    expect(await backend.namespaces.get("ns")).toEqual(namespace);
    const snapshot = await backend.snapshot("ns");
    expect(snapshot.status).toBe("changed");
    expect(await backend.snapshot("ns", { validator: snapshot.validator })).toEqual({
      status: "unchanged",
      validator: snapshot.validator,
    });
    const input: CardCreateInput = { partitionId: "partition", content: "Unsent content" };
    const options: MutationOptions = { keepalive: true };
    await expect(backend.cards.create("ns", input, options)).rejects.toMatchObject({
      code: "read_only",
    });
    await expect(backend.namespaces.create({ name: "Unsent namespace" })).rejects.toMatchObject({
      code: "read_only",
    });
    await expect(backend.snapshot("missing")).rejects.toBeInstanceOf(BackendError);
    expect(backend.version).toEqual(version);
    expect(changes).toEqual([]);
    expect(backend.taskspaces).toBeUndefined();
    unsubscribe();
    release();
  },
);
