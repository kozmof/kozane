import { describe, it, expect, vi } from "vitest";
import type { TaskspaceFileTree } from "$lib/types";
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
  return { fetcher, namespaceId: "namespace-1" };
}

describe("TaskspaceTreeState", () => {
  it("fetches a directory the first time it is opened and caches it after", async () => {
    const fetcher = fetcherFor(listing(["src", "app.ts"]));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");
    expect(tree.isExpanded(TS, "")).toBe(true);
    expect(tree.node(TS, "").entries?.map(({ name }) => name)).toEqual(["src", "app.ts"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/namespace-1/api/taskspaces/${TS}/files`);

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

    expect(fetcher).toHaveBeenCalledWith(`/namespace-1/api/taskspaces/${TS}/files?path=src%2Flib`);
  });

  it("keeps the truncation flag", async () => {
    const fetcher = fetcherFor(listing(["a.txt"], true));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");

    expect(tree.node(TS, "").truncated).toBe("entries");
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

  describe("ensure", () => {
    it("reads a directory without opening it in the panel", async () => {
      const fetcher = fetcherFor(listing(["src", "app.ts"]));
      const tree = new TaskspaceTreeState();

      await tree.ensure(context(fetcher as never), TS, "");

      expect(tree.node(TS, "").entries?.map(({ name }) => name)).toEqual(["src", "app.ts"]);
      // The whole reason this exists rather than calling `toggle`: a frame on the canvas
      // asking for a listing must not unfold rows in the right panel.
      expect(tree.isExpanded(TS, "")).toBe(false);
    });

    it("costs nothing on a directory already read", async () => {
      const fetcher = fetcherFor(listing(["app.ts"]));
      const tree = new TaskspaceTreeState();

      await tree.ensure(context(fetcher as never), TS, "");
      await tree.ensure(context(fetcher as never), TS, "");
      await tree.ensure(context(fetcher as never), TS, "");

      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("re-reads one it has when forced", async () => {
      const fetcher = fetcherFor(listing(["app.ts"]));
      const tree = new TaskspaceTreeState();

      await tree.ensure(context(fetcher as never), TS, "");
      fetcher.mockImplementation(async () => jsonResponse(listing(["app.ts", "new.ts"])));
      await tree.ensure(context(fetcher as never), TS, "", true);

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(tree.node(TS, "").entries?.map(({ name }) => name)).toEqual(["app.ts", "new.ts"]);
    });

    it("leaves a directory the panel opened alone, and shares what it read with the panel", async () => {
      const fetcher = fetcherFor(listing(["app.ts"]));
      const tree = new TaskspaceTreeState();

      await tree.toggle(context(fetcher as never), TS, "");
      await tree.ensure(context(fetcher as never), TS, "");

      // One cache, two readers: the panel's listing is what the frame draws from.
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(tree.isExpanded(TS, "")).toBe(true);
    });

    it("does not fire a second request while the first is in flight", async () => {
      const fetcher = vi.fn(async () => jsonResponse(listing(["app.ts"])));
      const tree = new TaskspaceTreeState();

      await Promise.all([
        tree.ensure(context(fetcher as never), TS, ""),
        tree.ensure(context(fetcher as never), TS, ""),
      ]);

      expect(fetcher).toHaveBeenCalledTimes(1);
    });
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

  describe("with an embedded static tree", () => {
    function staticContext(
      staticFiles: Record<string, TaskspaceFileTree>,
      fetcher = fetcherFor(listing(["should-not-be-fetched"])),
    ) {
      return {
        fetcher,
        ctx: { fetcher: fetcher as never, namespaceId: "namespace-1", staticFiles },
      };
    }

    // The behavior an export built without `--include-scoped-files` relies on: a taskspace
    // with no embedded tree must fall back to a live request, never invent an empty answer.
    it("still fetches when the context carries no static tree at all", async () => {
      const { fetcher, ctx } = staticContext({});
      const tree = new TaskspaceTreeState();

      await tree.toggle(ctx, TS, "");

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(tree.node(TS, "").entries?.map(({ name }) => name)).toEqual(["should-not-be-fetched"]);
    });

    it("reads a directory from the embedded tree instead of fetching, once it has one for this taskspace", async () => {
      const { fetcher, ctx } = staticContext({
        [TS]: {
          root: {
            kind: "directory",
            name: "",
            truncated: null,
            children: [
              { kind: "directory", name: "src", children: [], truncated: null },
              { kind: "file", name: "README.md", content: "hi\n", size: 3 },
              { kind: "file-skipped", name: "big.log", reason: "too-large", size: 2_000_000 },
            ],
          },
        },
      });
      const tree = new TaskspaceTreeState();

      await tree.toggle(ctx, TS, "");

      expect(fetcher).not.toHaveBeenCalled();
      expect(tree.node(TS, "").entries).toEqual([
        { name: "src", kind: "directory", size: null, modifiedAt: null },
        { name: "README.md", kind: "file", size: 3, modifiedAt: null },
        { name: "big.log", kind: "file", size: 2_000_000, modifiedAt: null },
      ]);
    });

    it("reads a nested directory from the embedded tree by path", async () => {
      const { fetcher, ctx } = staticContext({
        [TS]: {
          root: {
            kind: "directory",
            name: "",
            truncated: null,
            children: [
              {
                kind: "directory",
                name: "src",
                truncated: null,
                children: [{ kind: "file", name: "app.ts", content: "export {}\n", size: 10 }],
              },
            ],
          },
        },
      });
      const tree = new TaskspaceTreeState();

      await tree.toggle(ctx, TS, "src");

      expect(fetcher).not.toHaveBeenCalled();
      expect(tree.node(TS, "src").entries?.map(({ name }) => name)).toEqual(["app.ts"]);
    });

    // A taskspace without a resolvable path at build time (or a scopes-only export) has no
    // entry in the map at all — that must fall back the same as an empty map does, not
    // throw or silently show nothing.
    it("falls back to fetching for a taskspace absent from the static map", async () => {
      const { fetcher, ctx } = staticContext({
        "other-taskspace": { root: { kind: "directory", name: "", children: [], truncated: null } },
      });
      const tree = new TaskspaceTreeState();

      await tree.toggle(ctx, TS, "");

      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });
});

describe("TaskspaceTreeState creation", () => {
  /** Answers the create with `created`, then the re-read of the directory with `listed`. */
  function createThenList(created: unknown, listed: string[], status = 201) {
    let call = 0;
    return vi.fn(async () =>
      call++ === 0 ? jsonResponse(created, status) : jsonResponse(listing(listed)),
    );
  }

  it("posts a new file under the directory being typed into, and says to open it", async () => {
    const fetcher = createThenList({ path: "src/new.ts", content: "" }, ["new.ts"]);
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "src", "file");

    const made = await tree.submitCreate(context(fetcher as never), "new.ts");

    expect(made).toEqual({ taskspaceId: TS, kind: "file", path: "src/new.ts" });
    expect(fetcher).toHaveBeenNthCalledWith(1, `/namespace-1/api/taskspaces/${TS}/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "src/new.ts" }),
    });
    // The field closes only once the file is actually there.
    expect(tree.creating).toBeNull();
    expect(tree.createError).toBeNull();
  });

  it("posts a new folder to the listing route", async () => {
    const fetcher = createThenList({ path: "docs", entries: [], truncated: false }, ["docs"]);
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "", "directory");

    const made = await tree.submitCreate(context(fetcher as never), "docs");

    expect(made).toEqual({ taskspaceId: TS, kind: "directory", path: "docs" });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      `/namespace-1/api/taskspaces/${TS}/files`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "docs" }) }),
    );
  });

  it("re-reads the directory it created in, so the new row appears", async () => {
    const fetcher = createThenList({ path: "notes.md", content: "" }, ["notes.md"]);
    const tree = new TaskspaceTreeState();
    // Already read once: without the forced re-read the cached listing would be kept and
    // the file just made would not be on screen until something else refreshed it.
    tree.nodes[nodeKey(TS, "")] = {
      entries: [],
      truncated: null,
      loading: false,
      error: null,
    };
    tree.beginCreate(TS, "", "file");

    await tree.submitCreate(context(fetcher as never), "notes.md");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tree.node(TS, "").entries?.map(({ name }) => name)).toEqual(["notes.md"]);
  });

  it("keeps the field open with the reason when the name is taken", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "File already exists" }, 409));
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "", "file");

    expect(await tree.submitCreate(context(fetcher as never), "README.md")).toBeNull();
    expect(tree.createError).toBe("File already exists");
    expect(tree.creating).toEqual({ taskspaceId: TS, path: "", kind: "file" });
    expect(tree.createBusy).toBe(false);
  });

  it("refuses a name with a separator in it without asking the server", async () => {
    const fetcher = vi.fn();
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "", "file");

    expect(await tree.submitCreate(context(fetcher as never), "src/new.ts")).toBeNull();
    expect(tree.createError).toBe("File name cannot contain a path separator");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a dot-name, which the tree would never draw", async () => {
    const fetcher = vi.fn();
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "", "directory");

    expect(await tree.submitCreate(context(fetcher as never), ".git")).toBeNull();
    expect(tree.createError).toBe("Folder name cannot start with a dot");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a blank name", async () => {
    const fetcher = vi.fn();
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "", "file");

    expect(await tree.submitCreate(context(fetcher as never), "   ")).toBeNull();
    expect(tree.createError).toBe("File name is required");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("trims the name before sending it", async () => {
    const fetcher = createThenList({ path: "notes.md", content: "" }, ["notes.md"]);
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "", "file");

    const made = await tree.submitCreate(context(fetcher as never), "  notes.md  ");
    expect(made?.path).toBe("notes.md");
  });

  it("does nothing when no field is open", async () => {
    const fetcher = vi.fn();
    const tree = new TaskspaceTreeState();

    expect(await tree.submitCreate(context(fetcher as never), "notes.md")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a request that never arrived rather than throwing", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "", "file");

    expect(await tree.submitCreate(context(fetcher as never), "notes.md")).toBeNull();
    expect(tree.createError).toBe("Failed to create file");
    expect(tree.createBusy).toBe(false);
  });

  it("drops a field open on a taskspace that is no longer there", () => {
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "", "file");

    tree.prune(["taskspace-2"]);
    expect(tree.creating).toBeNull();
  });

  it("keeps a field open on a taskspace that survives a prune", () => {
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "src", "file");

    tree.prune([TS]);
    expect(tree.creating).toEqual({ taskspaceId: TS, path: "src", kind: "file" });
  });
});
