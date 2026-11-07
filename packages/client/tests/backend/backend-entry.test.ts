import { expect, it } from "vitest";
import {
  BackendError,
  HttpBackend,
  StaticBackend,
  type KozaneBackend,
  type SnapshotData,
  type CardCreateInput,
  type MutationOptions,
} from "../../src/backend/index.js";
import { tagDataset } from "./tags.fixtures.js";
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
  taskspaces: [
    { id: "t", name: "Notes", scopeId: null, path: null, pathKind: "workspace_relative" },
  ],
};
const tags = tagDataset();
tags.namespaces = [namespace];
tags.partitions = {};
const map = {
  namespaces: [namespace],
  partitions: [],
  scopes: [],
  activity: [],
  partitionUsage: [],
  namespaceUsage: [],
  tags: { hits: [], cardData: {}, cardNamespaces: {}, truncated: false },
};
const file = { path: "notes.md", content: "Notes", signature: null };
const listing = {
  path: "",
  entries: [{ name: "notes.md", kind: "file", size: 5, modifiedAt: null }],
  truncated: false,
};
const adapters: [string, () => KozaneBackend][] = [
  [
    "static",
    () =>
      new StaticBackend({
        namespaces: [namespace],
        snapshots: [data],
        tags,
        map,
        warpDirectories: { ns: [] },
        files: {
          t: {
            root: {
              kind: "directory",
              name: "Notes",
              truncated: null,
              children: [{ kind: "file", name: "notes.md", content: "Notes", size: 5 }],
            },
          },
        },
      }),
  ],
  [
    "http",
    () =>
      new HttpBackend({
        capabilities: {
          writable: false,
          persistent: true,
          taskspaces: true,
          externalWrites: false,
          auth: false,
        },
        fetcher: async (input) => {
          const path = String(input);
          if (path === "/api/tags" || path === "/api/tags?namespaceId=ns")
            return new Response(JSON.stringify(tags));
          if (path === "/api/map") return new Response(JSON.stringify(map));
          if (path === "/ns/api/warp-directory") return new Response("[]");
          if (path === "/ns/api/taskspaces/t/file?path=notes.md")
            return new Response(JSON.stringify(file));
          if (path === "/ns/api/taskspaces/t/files?path=")
            return new Response(JSON.stringify(listing));
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
    expect(await backend.tags.get()).toEqual(tags);
    expect(await backend.tags.get("ns")).toEqual(tags);
    expect(await backend.map.get()).toEqual(map);
    expect(await backend.warpDirectory.get("ns")).toEqual([]);
    expect(backend.taskspaces).toBeDefined();
    expect(await backend.taskspaces!.readFile("ns", "t", "notes.md")).toEqual(file);
    expect(await backend.taskspaces!.list("ns", "t", "")).toMatchObject(listing);
    await expect(backend.taskspaces!.saveFile("ns", "t", file)).rejects.toMatchObject({
      code: "read_only",
    });
    expect(backend.version).toEqual(version);
    expect(changes).toEqual([]);
    unsubscribe();
    release();
  },
);
