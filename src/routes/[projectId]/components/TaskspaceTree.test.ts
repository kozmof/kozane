import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import TaskspaceTree from "./TaskspaceTree.svelte";
import { TaskspaceTreeState } from "../lib/taskspace-tree.svelte.js";
import { TASKSPACE_DIR_ENTRIES_MAX } from "$lib/constants";

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

async function mount(byPath: Parameters<typeof fetcherFor>[0], path = "") {
  const fetcher = fetcherFor(byPath);
  const ctx = { fetcher: fetcher as never, projectId: "project-1" };
  const tree = new TaskspaceTreeState();
  await tree.toggle(ctx, TS, path);
  render(TaskspaceTree, { props: { tree, ctx, taskspaceId: TS, path } });
  return { tree, fetcher };
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
});

describe("TaskspaceTree opening a file", () => {
  async function mountWithOpen(
    byPath: Parameters<typeof fetcherFor>[0],
    onOpenFile?: (taskspacePath: string) => void,
  ) {
    const fetcher = fetcherFor(byPath);
    const ctx = { fetcher: fetcher as never, projectId: "project-1" };
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
    const ctx = { fetcher: fetcher as never, projectId: "project-1" };
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
