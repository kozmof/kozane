import { describe, it, expect, vi } from "vitest";
import { TaskspaceTreeState, nodeKey } from "./taskspace-tree.svelte.js";

const TS = "taskspace-1";

function listing(names: string[], truncated = false) {
  return {
    path: "",
    entries: names.map((name) => ({
      name,
      kind: name.includes(".") ? "file" : "directory",
      size: null,
      modifiedAt: null,
    })),
    truncated,
  };
}

/** A fresh Response per call: a body can only be read once. */
function fetcherFor(body: unknown, status = 200) {
  return vi.fn(async () => jsonResponse(body, status));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function context(fetcher: typeof fetch) {
  return { fetcher, projectId: "project-1" };
}

describe("TaskspaceTreeState", () => {
  it("fetches a directory the first time it is opened and caches it after", async () => {
    const fetcher = fetcherFor(listing(["src", "app.ts"]));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");
    expect(tree.isExpanded(TS, "")).toBe(true);
    expect(tree.node(TS, "").entries?.map(({ name }) => name)).toEqual(["src", "app.ts"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/project-1/api/taskspaces/${TS}/files`);

    await tree.toggle(context(fetcher as never), TS, "");
    expect(tree.isExpanded(TS, "")).toBe(false);

    await tree.toggle(context(fetcher as never), TS, "");
    expect(tree.isExpanded(TS, "")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("asks for a nested directory by path", async () => {
    const fetcher = fetcherFor(listing(["util.ts"]));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "src/lib");

    expect(fetcher).toHaveBeenCalledWith(`/project-1/api/taskspaces/${TS}/files?path=src%2Flib`);
  });

  it("keeps the truncation flag", async () => {
    const fetcher = fetcherFor(listing(["a.txt"], true));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");

    expect(tree.node(TS, "").truncated).toBe(true);
  });

  it("re-reads every open directory on refresh", async () => {
    const fetcher = fetcherFor(listing(["app.ts"]));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");
    await tree.toggle(context(fetcher as never), TS, "src");
    await tree.toggle(context(fetcher as never), "other", "");
    fetcher.mockClear();
    fetcher.mockImplementation(async () => jsonResponse(listing(["app.ts", "new.ts"])));

    await tree.refresh(context(fetcher as never), TS);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tree.node(TS, "").entries?.map(({ name }) => name)).toEqual(["app.ts", "new.ts"]);
    // The other taskspace was not asked about and keeps what it had.
    expect(tree.node("other", "").entries?.map(({ name }) => name)).toEqual(["app.ts"]);
  });

  it("surfaces the server's message when a listing fails", async () => {
    const fetcher = fetcherFor({ message: "Taskspace directory not found" }, 404);
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");

    expect(tree.node(TS, "")).toMatchObject({
      entries: null,
      loading: false,
      error: "Taskspace directory not found",
    });
  });

  it("reports a request that never arrived", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");

    expect(tree.node(TS, "").error).toBe("Failed to list files");
  });

  it("forgets taskspaces that are gone and keeps the ones that are not", async () => {
    const fetcher = fetcherFor(listing(["app.ts"]));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");
    await tree.toggle(context(fetcher as never), "other", "");

    tree.prune([TS]);

    expect(tree.isExpanded(TS, "")).toBe(true);
    expect(tree.isExpanded("other", "")).toBe(false);
    expect(Object.keys(tree.nodes)).toEqual([nodeKey(TS, "")]);
  });

  it("clears everything on reset", async () => {
    const fetcher = fetcherFor(listing(["app.ts"]));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");
    tree.reset();

    expect(tree.expanded.size).toBe(0);
    expect(tree.nodes).toEqual({});
  });
});
