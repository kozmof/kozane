import { httpEditorContext, staticEditorContext } from "../../../test-utils/editor-context.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { TaskspaceFileTree } from "$lib/types";
import {
  TaskspaceTreeState,
  nodeKey,
} from "../../../../../client/src/board/lib/taskspace-tree.svelte.js";

afterEach(() => vi.unstubAllGlobals());

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

/** Create a fresh Response per call because its body can be read only once. */
function fetcherFor(body: unknown, status = 200) {
  return vi.fn(async () => jsonResponse(body, status));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(
      typeof body === "object" && body !== null && "content" in body
        ? { signature: null, ...body }
        : body,
    ),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function context(fetcher: typeof fetch) {
  return httpEditorContext(fetcher, "namespace-1");
}

describe("TaskspaceTreeState", () => {
  it("fetches a directory the first time it is opened and caches it after", async () => {
    const fetcher = fetcherFor(listing(["src", "app.ts"]));
    const tree = new TaskspaceTreeState();

    await tree.toggle(context(fetcher as never), TS, "");
    expect(tree.isExpanded(TS, "")).toBe(true);
    expect(tree.node(TS, "").entries?.map(({ name }) => name)).toEqual(["src", "app.ts"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      `/namespace-1/api/taskspaces/${TS}/files?path=`,
      expect.objectContaining({ method: "GET" }),
    );

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

    expect(fetcher).toHaveBeenCalledWith(
      `/namespace-1/api/taskspaces/${TS}/files?path=src%2Flib`,
      expect.objectContaining({ method: "GET" }),
    );
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
      // Loading a frame's directory must not expand rows in the sidebar.
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

      // The panel and frame read the same cached listing.
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

    expect(tree.node(TS, "").error).toBe("Unable to reach the backend");
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
      vi.stubGlobal("fetch", fetcher);
      return { fetcher, ctx: staticEditorContext(staticFiles, "namespace-1") };
    }

    it("reports missing taskspaces without HTTP when the export has no trees", async () => {
      const { fetcher, ctx } = staticContext({});
      const tree = new TaskspaceTreeState();

      await tree.toggle(ctx, TS, "");

      expect(fetcher).not.toHaveBeenCalled();
      expect(tree.node(TS, "").error).toBe("Taskspace not found");
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

    it("reports a taskspace absent from the static backend without HTTP", async () => {
      const { fetcher, ctx } = staticContext({
        "other-taskspace": { root: { kind: "directory", name: "", children: [], truncated: null } },
      });
      const tree = new TaskspaceTreeState();

      await tree.toggle(ctx, TS, "");

      expect(fetcher).not.toHaveBeenCalled();
      expect(tree.node(TS, "").error).toBe("Taskspace not found");
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
      headers: expect.any(Headers),
      keepalive: false,
      body: JSON.stringify({ path: "src/new.ts" }),
      signal: expect.any(AbortSignal),
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
    // Force a refresh after creation so the cached listing includes the new file.
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
    expect(tree.createError).toBe("Unable to reach the backend");
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

describe("TaskspaceTreeState.create", () => {
  it("creates a file and re-reads its directory without opening the panel's field", async () => {
    let call = 0;
    const fetcher = vi.fn(async () =>
      call++ === 0
        ? jsonResponse({ path: "src/new.ts", content: "" }, 201)
        : jsonResponse(listing(["new.ts"])),
    );
    const tree = new TaskspaceTreeState();

    const made = await tree.create(
      context(fetcher as never),
      { taskspaceId: TS, path: "src", kind: "file" },
      "new.ts",
    );

    expect(made).toEqual({ taskspaceId: TS, kind: "file", path: "src/new.ts" });
    expect(tree.node(TS, "src").entries?.map(({ name }) => name)).toEqual(["new.ts"]);
    expect(tree.creating).toBeNull();
  });

  it("returns the reason instead of creating an invalid name", async () => {
    const fetcher = vi.fn();
    const tree = new TaskspaceTreeState();

    const made = await tree.create(
      context(fetcher as never),
      { taskspaceId: TS, path: "", kind: "file" },
      "a/b.ts",
    );

    expect(made).toEqual({ error: "File name cannot contain a path separator" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns the server's reason when it refuses", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "File already exists" }, 409));
    const tree = new TaskspaceTreeState();

    const made = await tree.create(
      context(fetcher as never),
      { taskspaceId: TS, path: "", kind: "file" },
      "README.md",
    );

    expect(made).toEqual({ error: "File already exists" });
  });
});

describe("TaskspaceTreeState rename and remove while listings are in flight", () => {
  /** A listing response that arrives only when `resolve` is called. */
  function deferred() {
    let resolve!: (res: Response) => void;
    const promise = new Promise<Response>((r) => (resolve = r));
    return { promise, resolve };
  }

  /**
   * Answer listings by path from `listings`, holding back any path in `held`, and accept
   * PATCH and DELETE on the files route.
   */
  function router(
    listings: Record<string, string[]>,
    held: Record<string, ReturnType<typeof deferred>> = {},
  ) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const { path, name } = JSON.parse(String(init.body));
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        return jsonResponse({ path: parent ? `${parent}/${name}` : name, kind: "directory" });
      }
      if (init?.method === "DELETE")
        return jsonResponse({
          path: new URL(url, "http://x").searchParams.get("path"),
          kind: "directory",
        });
      const path = new URL(url, "http://x").searchParams.get("path") ?? "";
      const hold = held[path];
      if (hold) {
        delete held[path];
        return hold.promise;
      }
      return jsonResponse(listing(listings[path] ?? []));
    });
  }

  it("re-reads a folder renamed while it was still loading, instead of leaving it stuck", async () => {
    const slow = deferred();
    const fetcher = router({ "": ["old"], old: ["a.ts"], new: ["a.ts"] }, { old: slow });
    const ctx = context(fetcher as never);
    const tree = new TaskspaceTreeState();
    await tree.toggle(ctx, TS, "");
    const opening = tree.toggle(ctx, TS, "old");
    expect(tree.node(TS, "old").loading).toBe(true);

    const result = await tree.rename(ctx, TS, "old", "new");
    expect(result).toEqual({ path: "new" });
    // The old request finishes late and must not bring the old key back.
    slow.resolve(jsonResponse(listing(["stale.ts"])));
    await opening;

    expect(tree.node(TS, "new")).toMatchObject({ loading: false, error: null });
    expect(tree.node(TS, "new").entries?.map(({ name }) => name)).toEqual(["a.ts"]);
    expect(tree.nodes[nodeKey(TS, "old")]).toBeUndefined();
    expect(tree.isExpanded(TS, "new")).toBe(true);
  });

  it("lets a forced re-read replace one in flight, and ignores the older answer", async () => {
    const slow = deferred();
    const fetcher = router({ "": ["after"] }, { "": slow });
    const ctx = context(fetcher as never);
    const tree = new TaskspaceTreeState();
    const first = tree.ensure(ctx, TS, "");

    await tree.ensure(ctx, TS, "", true);
    slow.resolve(jsonResponse(listing(["before"])));
    await first;

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tree.node(TS, "").entries?.map(({ name }) => name)).toEqual(["after"]);
  });

  it("drops a deleted folder's listing even when its answer arrives after the delete", async () => {
    const slow = deferred();
    const fetcher = router({ "": [] }, { gone: slow });
    const ctx = context(fetcher as never);
    const tree = new TaskspaceTreeState();
    await tree.toggle(ctx, TS, "");
    const opening = tree.toggle(ctx, TS, "gone");

    expect(await tree.remove(ctx, TS, "gone")).toBeNull();
    slow.resolve(jsonResponse(listing(["late.ts"])));
    await opening;

    expect(tree.nodes[nodeKey(TS, "gone")]).toBeUndefined();
    expect(tree.isExpanded(TS, "gone")).toBe(false);
  });

  it("closes a name field left open inside a deleted folder", async () => {
    const fetcher = router({ "": [] });
    const ctx = context(fetcher as never);
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "gone/sub", "file");

    await tree.remove(ctx, TS, "gone");

    expect(tree.creating).toBeNull();
  });

  it("moves a name field open inside a renamed folder to its new path", async () => {
    const fetcher = router({ "": ["new"] });
    const ctx = context(fetcher as never);
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "old/sub", "directory");

    await tree.rename(ctx, TS, "old", "new");

    expect(tree.creating).toEqual({ taskspaceId: TS, path: "new/sub", kind: "directory" });
  });

  it("leaves a name field in a folder that only shares the renamed one's prefix", async () => {
    const fetcher = router({ "": ["new"] });
    const ctx = context(fetcher as never);
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "old-sibling", "file");

    await tree.rename(ctx, TS, "old", "new");

    expect(tree.creating).toEqual({ taskspaceId: TS, path: "old-sibling", kind: "file" });
  });

  it("keeps a name field open elsewhere when an unrelated entry is deleted", async () => {
    const fetcher = router({ "": [] });
    const ctx = context(fetcher as never);
    const tree = new TaskspaceTreeState();
    tree.beginCreate(TS, "gone-too", "file");

    await tree.remove(ctx, TS, "gone");

    expect(tree.creating).toEqual({ taskspaceId: TS, path: "gone-too", kind: "file" });
  });
});

describe("taskspace backend tree integration", () => {
  it("uses the backend for listing and mutations and refreshes the parent", async () => {
    const { HttpClient } = await import("../../../../../client/src/client/http-client.js");
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) =>
      jsonResponse(
        options?.method === "POST"
          ? { path: "new", entries: [], truncated: false }
          : options?.method && options.method !== "GET"
            ? { path: "renamed", kind: "directory" }
            : listing(["renamed"]),
      ),
    );
    const backend = new HttpClient({
      base: "/demo",
      fetcher: fetcher as typeof fetch,
      capabilities: {
        writable: true,
        persistent: true,
        taskspaces: true,
        externalWrites: false,
        auth: false,
      },
    });
    const legacy = vi.fn();
    const ctx = { namespaceId: "namespace-1", fetcher: legacy as typeof fetch, backend };
    const tree = new TaskspaceTreeState();
    await tree.toggle(ctx, TS, "");
    expect(tree.node(TS, "").entries?.[0].name).toBe("renamed");
    expect(await tree.rename(ctx, TS, "old", "renamed")).toEqual({ path: "renamed" });
    expect(await tree.create(ctx, { taskspaceId: TS, path: "", kind: "directory" }, "new")).toEqual(
      { taskspaceId: TS, path: "new", kind: "directory" },
    );
    expect(await tree.remove(ctx, TS, "renamed")).toBeNull();
    expect(fetcher.mock.calls.map(([, options]) => options?.method ?? "GET")).toEqual([
      "GET",
      "PATCH",
      "GET",
      "POST",
      "GET",
      "DELETE",
      "GET",
    ]);
    expect(
      fetcher.mock.calls.every(([url]) =>
        String(url).startsWith("/demo/namespace-1/api/taskspaces/"),
      ),
    ).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("reports unavailable taskspaces without falling back to HTTP", async () => {
    const fetcher = vi.fn();
    const ctx = {
      namespaceId: "namespace-1",
      fetcher: fetcher as typeof fetch,
      backend: { taskspaces: undefined },
    };
    const tree = new TaskspaceTreeState();
    await tree.toggle(ctx, TS, "");
    expect(tree.node(TS, "").error).toBe("Taskspaces are not available");
    expect(await tree.remove(ctx, TS, "file.txt")).toEqual({
      error: "Taskspaces are not available",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("keeps static backend directory truncation reasons without falling back to HTTP", async () => {
  const { StaticClient } = await import("../../../../../client/src/client/static-client.js");
  const backend = new StaticClient({
    namespaces: [{ id: "namespace-1", name: "One", isDefault: true }],
    snapshots: [
      {
        namespace: { id: "namespace-1" },
        cards: [],
        partitions: [],
        layers: [],
        warps: [],
        inventories: [],
        scopes: [],
        scopeAreas: [],
        scopeRels: [],
        glueRels: [],
        taskspaces: [
          { id: TS, name: "Notes", scopeId: null, path: null, pathKind: "workspace_relative" },
        ],
      },
    ],
    files: {
      [TS]: {
        root: {
          kind: "directory",
          name: "notes",
          truncated: "depth",
          children: [{ kind: "file", name: "hello.md", content: "hello", size: 5 }],
        },
      },
    },
  });
  const fetcher = vi.fn();
  const tree = new TaskspaceTreeState();
  await tree.toggle({ namespaceId: "namespace-1", backend }, TS, "");
  expect(tree.node(TS, "").truncated).toBe("depth");
  expect(tree.node(TS, "").entries?.[0].name).toBe("hello.md");
  expect(fetcher).not.toHaveBeenCalled();
});

it("refreshes only watched directories, shares watchers and retains listings after failure", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    Response.json({
      ...listing(["before.md"]),
      path: new URL(String(url), "http://localhost").searchParams.get("path") ?? "",
    }),
  );
  const ctx = context(fetcher as typeof fetch);
  const tree = new TaskspaceTreeState();
  await tree.ensure(ctx, TS, "");
  await tree.ensure(ctx, TS, "closed");
  const one = tree.watch(TS, ""),
    two = tree.watch(TS, "");
  fetcher.mockClear();
  fetcher.mockResolvedValueOnce(Response.json({ message: "offline" }, { status: 503 }));
  expect(await tree.refreshWatched(ctx, () => true)).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(tree.node(TS, "").entries?.map((entry) => entry.name)).toEqual(["before.md"]);
  expect(tree.node(TS, "").error).not.toBeNull();
  one();
  one();
  fetcher.mockResolvedValueOnce(Response.json(listing(["after.md"])));
  expect(await tree.refreshWatched(ctx, () => true)).toBe(true);
  expect(tree.node(TS, "").entries?.map((entry) => entry.name)).toEqual(["after.md"]);
  expect(tree.node(TS, "").error).toBeNull();
  two();
  fetcher.mockClear();
  await tree.refreshWatched(ctx, () => true);
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects directory results after the last watcher closes", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const tree = new TaskspaceTreeState();
  const release = tree.watch(TS, "");
  const pending = tree.refreshWatched(context(fetcher as typeof fetch), () => true);
  release();
  finish(Response.json(listing(["late.md"])));
  await pending;
  expect(tree.node(TS, "").entries).toBeNull();
  expect(tree.node(TS, "").loading).toBe(false);
});
