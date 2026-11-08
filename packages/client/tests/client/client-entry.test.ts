import { expect, it } from "vitest";
import {
  ClientError,
  HttpClient,
  StaticClient,
  type KozaneClient,
  type SnapshotData,
  type CardCreateInput,
  type MutationOptions,
} from "../../src/client/index.js";
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
const adapters: [string, () => KozaneClient][] = [
  [
    "static",
    () =>
      new StaticClient({
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
      new HttpClient({
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
    const client: KozaneClient = create();
    const observed: string[] = [];
    const release = client.subscribeState((state) => observed.push(state.status));
    expect(observed).toEqual(["ready"]);
    const changes: unknown[] = [];
    const unsubscribe = client.subscribe((event) => changes.push(event));
    const version = client.version;
    expect(await client.namespaces.list()).toEqual([namespace]);
    expect(await client.namespaces.get("ns")).toEqual(namespace);
    const snapshot = await client.snapshot("ns");
    expect(snapshot.status).toBe("changed");
    expect(await client.snapshot("ns", { validator: snapshot.validator })).toEqual({
      status: "unchanged",
      validator: snapshot.validator,
    });
    const input: CardCreateInput = { partitionId: "partition", content: "Unsent content" };
    const options: MutationOptions = { keepalive: true };
    await expect(client.cards.create("ns", input, options)).rejects.toMatchObject({
      code: "read_only",
    });
    await expect(client.namespaces.create({ name: "Unsent namespace" })).rejects.toMatchObject({
      code: "read_only",
    });
    await expect(client.snapshot("missing")).rejects.toBeInstanceOf(ClientError);
    expect(client.version).toEqual(version);
    expect(changes).toEqual([]);
    expect(await client.tags.get()).toEqual(tags);
    expect(await client.tags.get("ns")).toEqual(tags);
    expect(await client.map.get()).toEqual(map);
    expect(await client.warpDirectory.get("ns")).toEqual([]);
    expect(client.taskspaces).toBeDefined();
    expect(await client.taskspaces!.readFile("ns", "t", "notes.md")).toEqual(file);
    expect(await client.taskspaces!.list("ns", "t", "")).toMatchObject(listing);
    await expect(client.taskspaces!.saveFile("ns", "t", file)).rejects.toMatchObject({
      code: "read_only",
    });
    expect(client.version).toEqual(version);
    expect(changes).toEqual([]);
    unsubscribe();
    release();
  },
);
