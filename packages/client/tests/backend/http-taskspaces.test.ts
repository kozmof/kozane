import { describe, expect, it, vi } from "vitest";
import { HttpClient, type TaskspacesApi } from "../../src/backend/index.js";
const ns = "n /";
const id = "t /";
const prefix = "/n%20%2F/api/taskspaces/t%20%2F";
const file = { path: "notes.md", content: "", signature: "signature" };
const listing = {
  path: "",
  entries: [{ name: "notes.md", kind: "file", size: 0, modifiedAt: null }],
  truncated: false,
};
interface Case {
  invoke: (api: TaskspacesApi) => Promise<unknown>;
  result: unknown;
  path: string;
  method: string;
}
const cases = {
  create: {
    invoke: (api) => api.create(ns, { name: "Notes", scopeId: "s" }),
    result: { id, path: "notes", pathKind: "workspace_relative" },
    path: "/n%20%2F/api/taskspaces",
    method: "POST",
  },
  rename: {
    invoke: (api) => api.rename(ns, id, { name: "Notes" }),
    result: { id, name: "Notes", path: null, pathKind: "absolute" },
    path: prefix,
    method: "PATCH",
  },
  remove: {
    invoke: (api) => api.remove(ns, id),
    result: { ok: true, directory: "kept" },
    path: prefix,
    method: "DELETE",
  },
  readFile: {
    invoke: (api) => api.readFile(ns, id, "notes.md"),
    result: file,
    path: prefix + "/file?path=notes.md",
    method: "GET",
  },
  saveFile: {
    invoke: (api) => api.saveFile(ns, id, file, { keepalive: true }),
    result: file,
    path: prefix + "/file",
    method: "PUT",
  },
  createFile: {
    invoke: (api) => api.createFile(ns, id, { path: "notes.md" }),
    result: file,
    path: prefix + "/file",
    method: "POST",
  },
  list: {
    invoke: (api) => api.list(ns, id, ""),
    result: listing,
    path: prefix + "/files?path=",
    method: "GET",
  },
  createDirectory: {
    invoke: (api) => api.createDirectory(ns, id, { path: "notes" }),
    result: { ...listing, path: "notes", entries: [] },
    path: prefix + "/files",
    method: "POST",
  },
  renameEntry: {
    invoke: (api) => api.renameEntry(ns, id, { path: "notes.md", name: "renamed.md" }),
    result: { path: "renamed.md", kind: "file" },
    path: prefix + "/files",
    method: "PATCH",
  },
  removeEntry: {
    invoke: (api) => api.removeEntry(ns, id, "notes.md"),
    result: { path: "notes.md", kind: "file" },
    path: prefix + "/files?path=notes.md",
    method: "DELETE",
  },
} satisfies Record<Exclude<keyof TaskspacesApi, "access">, Case>;
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: true,
  externalWrites: false,
  auth: false,
};
describe.each(Object.entries(cases))("taskspaces.%s", (name, operation) => {
  it("routes and decodes the complete result", async () => {
    const fetcher = vi.fn(async () => Response.json(operation.result));
    const backend = new HttpClient({ capabilities, fetcher });
    const listener = vi.fn();
    const release = backend.subscribe(listener);
    expect(await operation.invoke(backend.taskspaces!)).toEqual(operation.result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      operation.path,
      expect.objectContaining({ method: operation.method, keepalive: name === "saveFile" }),
    );
    expect(listener).toHaveBeenCalledTimes(operation.method === "GET" ? 0 : 1);
    release();
  });
  it("rejects malformed data without replay, retaining committed invalidations", async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const backend = new HttpClient({ capabilities, fetcher });
    const listener = vi.fn();
    const release = backend.subscribe(listener);
    await expect(operation.invoke(backend.taskspaces!)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(operation.method === "GET" ? 0 : 1);
    expect(backend.version.revision).toBe(operation.method === "GET" ? 0 : 1);
    release();
  });
  it("retains server error semantics without invalidation", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ message: "Changed on disk" }, { status: 409 }),
    );
    const backend = new HttpClient({ capabilities, fetcher });
    const listener = vi.fn();
    const release = backend.subscribe(listener);
    await expect(operation.invoke(backend.taskspaces!)).rejects.toMatchObject({
      code: "conflict",
      message: "Changed on disk",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    release();
  });
});
it("rejects a renamed record with the wrong identity after publishing its committed change", async () => {
  const backend = new HttpClient({
    capabilities,
    fetcher: async () =>
      Response.json({ id: "other", name: "Notes", path: null, pathKind: "absolute" }),
  });
  await expect(backend.taskspaces!.rename(ns, id, { name: "Notes" })).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(backend.version.revision).toBe(1);
});
it("forwards cancellation and rejects malformed committed JSON without retry", async () => {
  const controller = new AbortController();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(file))
    .mockResolvedValueOnce(new Response("invalid JSON"));
  const backend = new HttpClient({ capabilities, fetcher });
  await backend.taskspaces!.readFile(ns, id, "notes.md", { signal: controller.signal });
  const forwarded = fetcher.mock.calls[0][1].signal as AbortSignal;
  expect(forwarded.aborted).toBe(false);
  controller.abort();
  expect(forwarded.aborted).toBe(true);
  await expect(backend.taskspaces!.saveFile(ns, id, file)).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(backend.version.revision).toBe(1);
});
