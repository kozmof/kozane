import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import TaskspaceTree from "./TaskspaceTree.svelte";
import { TaskspaceTreeState } from "../lib/taskspace-tree.svelte.js";
import { TASKSPACE_DIR_ENTRIES_MAX, TASKSPACE_SSG_DEPTH_MAX } from "$lib/constants";
import type { TaskspaceFileTree } from "$lib/types";

const TS = "taskspace-1";

type Entry = { name: string; kind: string };

function entries(items: Entry[]) {
  return items.map(({ name, kind }) => ({ name, kind, size: null, modifiedAt: null }));
}

/** Answers each directory from `byPath`, so a click on a folder gets its own children. */
function fetcherFor(byPath: Record<string, { entries: Entry[]; truncated?: boolean }>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
    const listing = byPath[path];
    if (!listing)
      return new Response(JSON.stringify({ message: "Directory not found" }), { status: 404 });
    return new Response(
      JSON.stringify({
        path,
        entries: entries(listing.entries),
        truncated: listing.truncated === true,
      }),
      { status: 200 },
    );
  });
}

async function mount(
  byPath: Parameters<typeof fetcherFor>[0],
  path = "",
  props: { canCreate?: boolean; onOpenFile?: (taskspacePath: string) => void } = {},
) {
  const fetcher = fetcherFor(byPath);
  const ctx = { fetcher: fetcher as never, namespaceId: "namespace-1" };
  const tree = new TaskspaceTreeState();
  await tree.toggle(ctx, TS, path);
  render(TaskspaceTree, { props: { tree, ctx, taskspaceId: TS, path, ...props } });
  return { tree, fetcher, ctx };
}

describe("TaskspaceTree", () => {
  it("renders the directories and files of a listing", async () => {
    await mount({
      "": {
        entries: [
          { name: "src", kind: "directory" },
          { name: "app.ts", kind: "file" },
        ],
      },
    });

    expect(screen.getByRole("button", { name: /src/ })).toBeTruthy();
    expect(screen.getByText("app.ts")).toBeTruthy();
  });

  it("expands a directory on click and shows what is in it", async () => {
    const { fetcher } = await mount({
      "": { entries: [{ name: "src", kind: "directory" }] },
      src: { entries: [{ name: "util.ts", kind: "file" }] },
    });

    await userEvent.click(screen.getByRole("button", { name: /src/ }));

    expect(await screen.findByText("util.ts")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not offer to expand a file or a symlink", async () => {
    await mount({
      "": {
        entries: [
          { name: "app.ts", kind: "file" },
          { name: "link", kind: "symlink" },
        ],
      },
    });

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says when a directory is empty", async () => {
    await mount({ "": { entries: [] } });
    expect(screen.getByText("Empty")).toBeTruthy();
  });

  it("says when a listing was cut off", async () => {
    await mount({ "": { entries: [{ name: "a.txt", kind: "file" }], truncated: true } });
    expect(screen.getByText(`First ${TASKSPACE_DIR_ENTRIES_MAX} entries only`)).toBeTruthy();
  });

  it("shows the reason a listing failed", async () => {
    await mount({ other: { entries: [] } });
    expect(screen.getByText("Directory not found")).toBeTruthy();
  });

  /**
   * Report why exported directories were truncated so an unread subtree is not presented as
   * empty.
   */
  describe("a directory of a static export cut off by a limit", () => {
    async function mountStatic(root: TaskspaceFileTree["root"]) {
      const ctx = {
        fetcher: vi.fn() as never,
        namespaceId: "namespace-1",
        staticFiles: { [TS]: { root } },
      };
      const tree = new TaskspaceTreeState();
      await tree.toggle(ctx, TS, "");
      render(TaskspaceTree, { props: { tree, ctx, taskspaceId: TS, path: "" } });
    }

    it("says a directory was too deep to walk, rather than calling it empty", async () => {
      await mountStatic({ kind: "directory", name: "", children: [], truncated: "depth" });

      expect(screen.queryByText("Empty")).toBeNull();
      expect(
        screen.getByText(
          `Nested deeper than ${TASKSPACE_SSG_DEPTH_MAX} levels — not included in this export`,
        ),
      ).toBeTruthy();
    });

    it("says a directory was past the export's size limit", async () => {
      await mountStatic({ kind: "directory", name: "", children: [], truncated: "nodes" });

      expect(screen.queryByText("Empty")).toBeNull();
      expect(screen.getByText("Past this export's size limit — not included")).toBeTruthy();
    });

    it("says a directory could not be read", async () => {
      await mountStatic({ kind: "directory", name: "", children: [], truncated: "unreadable" });

      expect(screen.queryByText("Empty")).toBeNull();
      expect(screen.getByText("Could not be read")).toBeTruthy();
    });
  });
});

describe("TaskspaceTree opening a file", () => {
  async function mountWithOpen(
    byPath: Parameters<typeof fetcherFor>[0],
    onOpenFile?: (taskspacePath: string) => void,
  ) {
    const fetcher = fetcherFor(byPath);
    const ctx = { fetcher: fetcher as never, namespaceId: "namespace-1" };
    const tree = new TaskspaceTreeState();
    await tree.toggle(ctx, TS, "");
    render(TaskspaceTree, { props: { tree, ctx, taskspaceId: TS, path: "", onOpenFile } });
    return { tree, fetcher };
  }

  it("asks to open a file when its row is clicked", async () => {
    const onOpenFile = vi.fn();
    await mountWithOpen({ "": { entries: [{ name: "app.ts", kind: "file" }] } }, onOpenFile);

    await userEvent.click(screen.getByRole("button", { name: /app\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith("app.ts");
  });

  it("names a file in a subdirectory by its path from the taskspace root", async () => {
    const onOpenFile = vi.fn();
    const fetcher = fetcherFor({
      "": { entries: [{ name: "src", kind: "directory" }] },
      src: { entries: [{ name: "app.ts", kind: "file" }] },
    });
    const ctx = { fetcher: fetcher as never, namespaceId: "namespace-1" };
    const tree = new TaskspaceTreeState();
    await tree.toggle(ctx, TS, "");
    render(TaskspaceTree, { props: { tree, ctx, taskspaceId: TS, path: "", onOpenFile } });

    await userEvent.click(screen.getByRole("button", { name: /src/ }));
    await userEvent.click(await screen.findByRole("button", { name: /app\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("leaves a symbolic link inert, because following one is not something a read can do", async () => {
    const onOpenFile = vi.fn();
    await mountWithOpen({ "": { entries: [{ name: "link", kind: "symlink" }] } }, onOpenFile);

    expect(screen.queryByRole("button", { name: /link/ })).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("leaves every row inert when there is no handler, as a static export has none", async () => {
    await mountWithOpen({ "": { entries: [{ name: "app.ts", kind: "file" }] } }, undefined);
    expect(screen.queryByRole("button", { name: /app\.ts/ })).toBeNull();
    expect(screen.getByText("app.ts")).toBeInTheDocument();
  });
});

describe("TaskspaceTree creation", () => {
  /** Answers the POST with `created`, and every listing from `byPath` as usual. */
  function creatingFetcher(
    byPath: Parameters<typeof fetcherFor>[0],
    created: unknown,
    status = 201,
  ) {
    const list = fetcherFor(byPath);
    return vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify(created), { status })
        : list(url as never),
    );
  }

  async function mountCreating(
    byPath: Parameters<typeof fetcherFor>[0],
    created: unknown,
    onOpenFile?: (taskspacePath: string) => void,
    status = 201,
  ) {
    const fetcher = creatingFetcher(byPath, created, status);
    const ctx = { fetcher: fetcher as never, namespaceId: "namespace-1" };
    const tree = new TaskspaceTreeState();
    await tree.toggle(ctx, TS, "");
    render(TaskspaceTree, {
      props: { tree, ctx, taskspaceId: TS, path: "", canCreate: true, onOpenFile },
    });
    return { tree, fetcher };
  }

  it("offers no create controls unless the tree is asked to", async () => {
    await mount({ "": { entries: [{ name: "src", kind: "directory" }] } });
    expect(screen.queryByRole("button", { name: "New file in this folder" })).toBeNull();
  });

  it("puts a pair of controls on every directory row", async () => {
    await mount({ "": { entries: [{ name: "src", kind: "directory" }] } }, "", {
      canCreate: true,
    });

    expect(screen.getByRole("button", { name: "New file in this folder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New folder in this folder" })).toBeTruthy();
  });

  it("opens the folder it will create in, and shows the field there", async () => {
    const { tree, fetcher } = await mount(
      { "": { entries: [{ name: "src", kind: "directory" }] }, src: { entries: [] } },
      "",
      { canCreate: true },
    );

    await userEvent.click(screen.getByRole("button", { name: "New file in this folder" }));

    expect(tree.creating).toEqual({ taskspaceId: TS, path: "src", kind: "file" });
    expect(tree.isExpanded(TS, "src")).toBe(true);
    // The folder was read on the way, so the field is drawn among rows rather than alone.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("New file name")).toBeTruthy();
  });

  it("creates the file on Enter and hands it to the editor", async () => {
    const onOpenFile = vi.fn();
    const { tree } = await mountCreating(
      { "": { entries: [{ name: "notes.md", kind: "file" }] } },
      { path: "notes.md", content: "", signature: "1:2:0" },
      onOpenFile,
    );
    tree.beginCreate(TS, "", "file");

    const field = await screen.findByLabelText("New file name");
    await userEvent.type(field, "notes.md{Enter}");

    expect(onOpenFile).toHaveBeenCalledWith("notes.md");
    expect(tree.creating).toBeNull();
  });

  it("creates a folder without sending anything to the editor", async () => {
    const onOpenFile = vi.fn();
    const { tree } = await mountCreating(
      { "": { entries: [{ name: "docs", kind: "directory" }] } },
      { path: "docs", entries: [], truncated: false },
      onOpenFile,
    );
    tree.beginCreate(TS, "", "directory");

    await userEvent.type(await screen.findByLabelText("New folder name"), "docs{Enter}");

    expect(onOpenFile).not.toHaveBeenCalled();
    expect(tree.creating).toBeNull();
  });

  it("shows why a name was refused and keeps the field", async () => {
    const { tree } = await mountCreating(
      { "": { entries: [] } },
      { message: "File already exists" },
      undefined,
      409,
    );
    tree.beginCreate(TS, "", "file");

    await userEvent.type(await screen.findByLabelText("New file name"), "notes.md{Enter}");

    expect(screen.getByRole("alert").textContent).toContain("File already exists");
    expect(tree.creating).not.toBeNull();
  });

  it("puts the field away on Escape", async () => {
    const { tree } = await mount({ "": { entries: [] } }, "", { canCreate: true });
    tree.beginCreate(TS, "", "file");

    await userEvent.type(await screen.findByLabelText("New file name"), "{Escape}");
    expect(tree.creating).toBeNull();
  });
});
