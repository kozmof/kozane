import { afterEach, expect, it, vi } from "vitest";
import { StaticBackend, type StaticBackendData } from "./static-backend.js";
import type { SnapshotData } from "./contract.js";
import type { TaskspaceFileTree } from "../types.js";
import { tagDataset } from "./tags.fixtures.js";
function snapshot(id: string): SnapshotData {
  return {
    namespace: { id },
    cards: [],
    partitions: [],
    layers: [],
    warps: [],
    inventories: [],
    scopes: [],
    scopeAreas: [],
    scopeRels: [],
    glueRels: [],
    taskspaces: [],
  };
}
const files: TaskspaceFileTree = {
  root: {
    kind: "directory",
    name: "notes",
    truncated: "depth",
    children: [
      { kind: "file", name: "hello.md", content: "hello", size: 5 },
      { kind: "file-skipped", name: "skipped.md", reason: "budget", size: 50 },
      { kind: "symlink", name: "link" },
    ],
  },
};
function fixture(): StaticBackendData {
  const namespaces = [
    { id: "p1", name: "One", isDefault: true },
    { id: "p2", name: "Two", isDefault: false },
  ];
  const one = snapshot("p1");
  one.taskspaces = [
    { id: "t1", name: "Notes", scopeId: null, path: null, pathKind: "workspace_relative" },
  ];
  const tags = tagDataset([
    { tag: "perf", excerpt: "one", source: { kind: "card", cardId: "c1" } },
    { tag: "perf", excerpt: "two", source: { kind: "card", cardId: "c2" } },
    ...["t1", "t2", "unplaced"].map((taskspaceId) => ({
      tag: "perf",
      excerpt: taskspaceId,
      source: { kind: "file" as const, taskspaceId, path: "hello.md", line: 1 },
    })),
  ]);
  tags.namespaces = namespaces;
  tags.index.cardNamespaces.c2 = "p2";
  tags.index.cardData.c2 = { namespaceId: "p2", partitionId: "b2", updatedDay: "2026-09-06" };
  tags.cardPartitions[1].partitionId = "b2";
  tags.partitions.b2 = { name: "Other", dot: "blue" };
  tags.index.taskspaces.t2 = { name: "Two files", namespaceId: "p2" };
  tags.index.taskspaces.unplaced = { name: "Unplaced", namespaceId: null };
  tags.index.truncated = [
    { taskspaceId: "t1", reasons: ["budget"], paths: ["skipped.md"] },
    { taskspaceId: "t2", reasons: ["depth"], paths: [] },
  ];
  tags.index.missing = ["t1", "t2"];
  return {
    namespaces,
    snapshots: [one, snapshot("p2")],
    tags,
    map: {
      namespaces,
      partitions: [],
      scopes: [],
      activity: [],
      partitionUsage: [],
      namespaceUsage: [],
      tags: { hits: [], cardData: {}, cardNamespaces: {}, truncated: false },
    },
    warpDirectories: {
      p1: [
        {
          id: "w2",
          namespaceId: "p2",
          namespaceName: "Two",
          label: 1,
          posX: 1,
          posY: 2,
          hint: "hint",
          isCurrent: false,
        },
      ],
      p2: [],
    },
    files: { t1: files },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("starts ready with immutable capabilities and stamps without polling or storage access", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const storage = vi.fn(() => {
    throw new Error("storage denied");
  });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: storage });
  try {
    const backend = new StaticBackend(fixture());
    expect(backend.capabilities).toEqual({
      writable: false,
      persistent: true,
      taskspaces: true,
      externalWrites: false,
      auth: false,
    });
    expect(Object.isFrozen(backend.capabilities)).toBe(true);
    expect(Object.isFrozen(backend.version)).toBe(true);
    const listener = vi.fn();
    const release = backend.subscribe(listener);
    const state = vi.fn();
    const releaseState = backend.subscribeState(state);
    expect(state).toHaveBeenCalledExactlyOnceWith({ status: "ready" });
    expect(() =>
      backend.subscribeState(() => {
        throw new Error("listener");
      }),
    ).not.toThrow();
    await backend.namespaces.list();
    await backend.snapshot("p1");
    await backend.tags.get();
    await backend.map.get();
    await backend.warpDirectory.get("p1");
    await backend.taskspaces!.readFile("p1", "t1", "hello.md");
    expect(listener).not.toHaveBeenCalled();
    release();
    release();
    releaseState();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
it("binds conditional snapshots to the backend and namespace and handles eviction and missing namespaces", async () => {
  const backend = new StaticBackend(fixture(), { validatorCapacity: 1 });
  const first = await backend.snapshot("p1");
  expect(first.status).toBe("changed");
  expect(await backend.snapshot("p1", { validator: first.validator })).toEqual({
    status: "unchanged",
    validator: first.validator,
  });
  expect((await backend.snapshot("p2", { validator: first.validator })).status).toBe("changed");
  expect((await backend.snapshot("p1", { validator: first.validator })).status).toBe("changed");
  expect(
    (await new StaticBackend(fixture()).snapshot("p1", { validator: first.validator })).status,
  ).toBe("changed");
  await expect(backend.snapshot("missing", { validator: first.validator })).rejects.toMatchObject({
    code: "not_found",
  });
});
it("defensively copies inputs and read results without changing the snapshot validator", async () => {
  const input = fixture();
  const backend = new StaticBackend(input);
  input.namespaces[0].name = "changed source";
  const rows = await backend.namespaces.list();
  expect(rows[0].name).toBe("One");
  rows[0].name = "changed result";
  expect((await backend.namespaces.get("p1")).name).toBe("One");
  const first = await backend.snapshot("p1");
  if (first.status !== "changed") throw new Error("missing initial data");
  first.data.namespace.id = "tampered";
  expect(await backend.snapshot("p1", { validator: first.validator })).toEqual({
    status: "unchanged",
    validator: first.validator,
  });
  const fresh = await backend.snapshot("p1");
  if (fresh.status !== "changed") throw new Error("missing data");
  expect(fresh.data.namespace.id).toBe("p1");
  const tags = await backend.tags.get();
  tags.index.hits[0].excerpt = "changed";
  expect((await backend.tags.get()).index.hits[0].excerpt).toBe("one");
  const map = await backend.map.get();
  map.namespaces[0].name = "changed";
  expect((await backend.map.get()).namespaces[0].name).toBe("One");
  const directory = await backend.warpDirectory.get("p1");
  directory.length = 0;
  expect(await backend.warpDirectory.get("p1")).toHaveLength(1);
});
it("filters static tag hits, labels and warnings by namespace while retaining unplaced files", async () => {
  const backend = new StaticBackend(fixture());
  const one = await backend.tags.get("p1");
  expect(one.index.hits.map((hit) => hit.excerpt)).toEqual(["one", "t1", "unplaced"]);
  expect(Object.keys(one.index.taskspaces)).toEqual(["t1", "unplaced"]);
  expect(one.index.truncated.map((row) => row.taskspaceId)).toEqual(["t1"]);
  expect(one.index.missing).toEqual(["t1"]);
  expect(one.cardPartitions.map((row) => row.cardId)).toEqual(["c1"]);
  expect(one.index.cardNamespaces).toEqual({ c1: "p1" });
  expect((await backend.tags.get("p2")).index.hits.map((hit) => hit.excerpt)).toEqual([
    "two",
    "t2",
    "unplaced",
  ]);
  await expect(backend.tags.get("missing")).rejects.toMatchObject({ code: "not_found" });
});
it("retains directory truncation, skipped-file explanations and namespace visibility", async () => {
  const backend = new StaticBackend(fixture());
  const api = backend.taskspaces!;
  expect(await api.readFile("p1", "t1", "hello.md")).toEqual({
    path: "hello.md",
    content: "hello",
    signature: null,
  });
  const listing = await api.list("p1", "t1", "");
  expect(listing).toMatchObject({ path: "", truncated: true, truncation: "depth" });
  expect(listing.entries.map((row) => row.kind)).toEqual(["file", "file", "symlink"]);
  expect(listing.entries.every((row) => row.modifiedAt === null)).toBe(true);
  listing.entries[0].name = "changed";
  expect((await api.list("p1", "t1", "")).entries[0].name).toBe("hello.md");
  await expect(api.readFile("p1", "t1", "skipped.md")).rejects.toMatchObject({
    code: "limit",
    message: "This export's size budget ran out before reaching this file.",
  });
  await expect(api.readFile("p2", "t1", "hello.md")).rejects.toMatchObject({ code: "not_found" });
  await expect(api.readFile("p1", "t1", "../hello.md")).rejects.toMatchObject({
    code: "not_found",
  });
  const without = new StaticBackend({ namespaces: fixture().namespaces });
  expect(without.capabilities.taskspaces).toBe(false);
  expect(without.taskspaces).toBeUndefined();
});
it("rejects every exposed mutation with read_only and publishes no invalidation", async () => {
  const backend = new StaticBackend(fixture());
  const observed = vi.fn();
  backend.subscribe(observed);
  const stamp = backend.version;
  const methods = [
    backend.namespaces.create,
    ...Object.values(backend.cards),
    ...Object.values(backend.glues),
    ...Object.values(backend.layers),
    ...Object.values(backend.partitions),
    ...Object.values(backend.scopes),
    ...Object.values(backend.warps),
    ...Object.values(backend.inventories),
    ...Object.entries(backend.taskspaces!)
      .filter(([name]) => name !== "readFile" && name !== "list" && name !== "access")
      .map(([, method]) => method),
  ];
  for (const method of methods)
    await expect((method as () => Promise<unknown>)()).rejects.toMatchObject({ code: "read_only" });
  expect(backend.version).toBe(stamp);
  expect(observed).not.toHaveBeenCalled();
});
it("reports omitted datasets separately from missing namespaces and rejects malformed exports", async () => {
  const backend = new StaticBackend({ namespaces: fixture().namespaces });
  await expect(backend.snapshot("p1")).rejects.toMatchObject({ code: "unavailable" });
  await expect(backend.tags.get()).rejects.toMatchObject({ code: "unavailable" });
  await expect(backend.map.get()).rejects.toMatchObject({ code: "unavailable" });
  await expect(backend.warpDirectory.get("p1")).rejects.toMatchObject({ code: "unavailable" });
  await expect(backend.namespaces.get("missing")).rejects.toMatchObject({ code: "not_found" });
  expect(() => new StaticBackend({ ...fixture(), snapshots: [snapshot("missing")] })).toThrow(
    "Invalid static export data",
  );
  const cycle: TaskspaceFileTree = {
    root: { kind: "directory", name: "root", children: [], truncated: null },
  };
  cycle.root.children.push(cycle.root);
  expect(() => new StaticBackend({ ...fixture(), files: { t1: cycle } })).toThrow(
    "Invalid static export data",
  );
});

it("does not read inherited dictionary properties as opaque resource IDs", async () => {
  const data = snapshot("__proto__");
  data.taskspaces = [
    { id: "constructor", name: "Notes", scopeId: null, path: null, pathKind: "workspace_relative" },
  ];
  const backend = new StaticBackend({
    namespaces: [{ id: "__proto__", name: "One", isDefault: true }],
    snapshots: [data],
    warpDirectories: {},
    files: {},
  });
  await expect(backend.warpDirectory.get("__proto__")).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(
    backend.taskspaces!.readFile("__proto__", "constructor", "hello.md"),
  ).rejects.toMatchObject({ code: "not_found" });
});
