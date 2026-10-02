import { describe, it, expect } from "vitest";
import type { TaskspaceEntry, TaskspaceSummary } from "$lib/types";
import {
  CELL_WIDTH,
  MIN_STRIP_WIDTH,
  baseName,
  columnsIn,
  cwdFor,
  cwdKey,
  fileGroupsForArea,
  parentPath,
  pruneCwd,
  sortEntries,
  stripWidth,
  taskspacesForScope,
  visibleCells,
  type FileCell,
} from "./scope-area-files.js";
import type { TaskspaceNode } from "./taskspace-tree.svelte.js";

const taskspace = (overrides: Partial<TaskspaceSummary> = {}): TaskspaceSummary => ({
  id: "t1",
  name: "work",
  scopeId: "s1",
  path: "work",
  pathKind: "workspace_relative",
  ...overrides,
});

const entry = (name: string, kind: TaskspaceEntry["kind"] = "file"): TaskspaceEntry => ({
  name,
  kind,
  size: null,
  modifiedAt: null,
});

const node = (overrides: Partial<TaskspaceNode> = {}): TaskspaceNode => ({
  entries: null,
  truncated: null,
  loading: false,
  error: null,
  ...overrides,
});

const UNREAD = node();

/** The cells of a group, as the names a reader would see, in the order they are drawn. */
function labels(cells: FileCell[]): string[] {
  return cells.map((cell) => (cell.kind === "up" ? `‹ ${cell.label}` : cell.entry.name));
}

describe("taskspacesForScope", () => {
  const rows = [
    taskspace({ id: "t1", scopeId: "s1" }),
    taskspace({ id: "t2", scopeId: "s2" }),
    taskspace({ id: "t3", scopeId: "s1" }),
  ];

  it("keeps the scope's own taskspaces, in the order it was given them", () => {
    expect(taskspacesForScope(rows, "s1").map(({ id }) => id)).toEqual(["t1", "t3"]);
  });

  it("leaves out a taskspace with no path, which this board cannot list", () => {
    const withoutPath = [taskspace({ id: "t9", path: null })];
    expect(taskspacesForScope(withoutPath, "s1")).toEqual([]);
  });

  it("keeps a pathless taskspace the export baked a tree in for", () => {
    const withoutPath = [taskspace({ id: "t9", path: null })];
    const staticFiles = {
      t9: { root: { kind: "directory" as const, name: "", children: [], truncated: null } },
    };
    expect(taskspacesForScope(withoutPath, "s1", staticFiles).map(({ id }) => id)).toEqual(["t9"]);
  });
});

describe("sortEntries", () => {
  it("puts directories first, then names", () => {
    const sorted = sortEntries([
      entry("readme.md"),
      entry("src", "directory"),
      entry("app.ts"),
      entry("docs", "directory"),
    ]);
    expect(sorted.map(({ name }) => name)).toEqual(["docs", "src", "app.ts", "readme.md"]);
  });

  it("sorts symlinks and oddities in with the files, where their names put them", () => {
    const sorted = sortEntries([entry("b.ts"), entry("a-link", "symlink"), entry("c", "other")]);
    expect(sorted.map(({ name }) => name)).toEqual(["a-link", "b.ts", "c"]);
  });

  it("leaves what it was given alone", () => {
    const given = [entry("b.ts"), entry("a.ts")];
    sortEntries(given);
    expect(given.map(({ name }) => name)).toEqual(["b.ts", "a.ts"]);
  });
});

describe("cwdFor", () => {
  const cwd = { [cwdKey("a1", "t1")]: "src/lib" };

  it("gives back the directory a frame was pointed at", () => {
    expect(cwdFor(cwd, "a1", "t1")).toBe("src/lib");
  });

  it("takes an unvisited pairing to be at the taskspace root", () => {
    expect(cwdFor(cwd, "a2", "t1")).toBe("");
    expect(cwdFor(cwd, "a1", "t2")).toBe("");
    expect(cwdFor({}, "a1", "t1")).toBe("");
  });
});

describe("parentPath and baseName", () => {
  it("reads a nested path apart", () => {
    expect(parentPath("src/lib/util.ts")).toBe("src/lib");
    expect(baseName("src/lib/util.ts")).toBe("util.ts");
  });

  it("takes a root entry's parent to be the root", () => {
    expect(parentPath("src")).toBe("");
    expect(baseName("src")).toBe("src");
  });
});

describe("fileGroupsForArea", () => {
  it("draws one group per taskspace, each sorted", () => {
    const groups = fileGroupsForArea({
      areaId: "a1",
      taskspaces: [taskspace({ id: "t1", name: "work" }), taskspace({ id: "t2", name: "notes" })],
      cwdByKey: {},
      nodeOf: (taskspaceId) =>
        node({
          entries:
            taskspaceId === "t1"
              ? [entry("app.ts"), entry("src", "directory")]
              : [entry("today.md")],
        }),
    });

    expect(groups.map(({ taskspaceId, name }) => [taskspaceId, name])).toEqual([
      ["t1", "work"],
      ["t2", "notes"],
    ]);
    expect(labels(groups[0].cells)).toEqual(["src", "app.ts"]);
    expect(labels(groups[1].cells)).toEqual(["today.md"]);
  });

  it("carries each cell's path relative to the taskspace root", () => {
    const [group] = fileGroupsForArea({
      areaId: "a1",
      taskspaces: [taskspace()],
      cwdByKey: { [cwdKey("a1", "t1")]: "src/lib" },
      nodeOf: () => node({ entries: [entry("util.ts")] }),
    });

    expect(group.cells).toEqual([
      { kind: "up", label: "lib", path: "src" },
      { kind: "entry", entry: entry("util.ts"), path: "src/lib/util.ts" },
    ]);
  });

  it("leads a drilled-into directory with the way out, and the root with nothing", () => {
    const inside = fileGroupsForArea({
      areaId: "a1",
      taskspaces: [taskspace()],
      cwdByKey: { [cwdKey("a1", "t1")]: "src" },
      nodeOf: () => node({ entries: [entry("a.ts")] }),
    });
    const root = fileGroupsForArea({
      areaId: "a1",
      taskspaces: [taskspace()],
      cwdByKey: {},
      nodeOf: () => node({ entries: [entry("a.ts")] }),
    });

    expect(labels(inside[0].cells)).toEqual(["‹ src", "a.ts"]);
    expect(labels(root[0].cells)).toEqual(["a.ts"]);
  });

  it("tells a directory not yet read from one that is genuinely empty", () => {
    const unread = fileGroupsForArea({
      areaId: "a1",
      taskspaces: [taskspace()],
      cwdByKey: {},
      nodeOf: () => node({ loading: true }),
    });
    const empty = fileGroupsForArea({
      areaId: "a1",
      taskspaces: [taskspace()],
      cwdByKey: {},
      nodeOf: () => node({ entries: [] }),
    });

    expect(unread[0]).toMatchObject({ read: false, loading: true, cells: [] });
    expect(empty[0]).toMatchObject({ read: true, loading: false, cells: [] });
  });

  it("carries a listing's truncation and its error through", () => {
    const [group] = fileGroupsForArea({
      areaId: "a1",
      taskspaces: [taskspace()],
      cwdByKey: {},
      nodeOf: () => node({ entries: [], truncated: "entries", error: "Failed to list files" }),
    });

    expect(group.truncated).toBe("entries");
    expect(group.error).toBe("Failed to list files");
  });

  it("asks each taskspace about the directory this frame is pointed at", () => {
    const asked: string[] = [];
    fileGroupsForArea({
      areaId: "a2",
      taskspaces: [taskspace({ id: "t1" }), taskspace({ id: "t2" })],
      // Only one of the two has been drilled into, and only under this frame.
      cwdByKey: { [cwdKey("a2", "t1")]: "src" },
      nodeOf: (taskspaceId, path) => {
        asked.push(`${taskspaceId}:${path}`);
        return UNREAD;
      },
    });

    expect(asked).toEqual(["t1:src", "t2:"]);
  });

  it("reads only its own frame's view, not another frame's of the same taskspace", () => {
    const asked: string[] = [];
    fileGroupsForArea({
      areaId: "a1",
      taskspaces: [taskspace({ id: "t1" })],
      cwdByKey: { [cwdKey("a2", "t1")]: "src" },
      nodeOf: (taskspaceId, path) => {
        asked.push(`${taskspaceId}:${path}`);
        return UNREAD;
      },
    });

    expect(asked).toEqual(["t1:"]);
  });

  it("has no groups for a scope with no taskspaces", () => {
    expect(
      fileGroupsForArea({ areaId: "a1", taskspaces: [], cwdByKey: {}, nodeOf: () => UNREAD }),
    ).toEqual([]);
  });
});

describe("stripWidth", () => {
  it("follows the frame once the frame is wide enough to lay cells out in", () => {
    expect(stripWidth({ width: 640 })).toBe(640);
  });

  it("does not shrink below the minimum with the frame", () => {
    // A frame may be as small as `SCOPE_AREA_MIN_SIZE`, which is under two cells wide. The
    // strip sits outside the frame, so it is free to be wider than the box it hangs from.
    expect(stripWidth({ width: 120 })).toBe(MIN_STRIP_WIDTH);
  });
});

describe("columnsIn", () => {
  it("fits as many whole cells as the width allows", () => {
    expect(columnsIn(CELL_WIDTH * 4)).toBe(4);
    expect(columnsIn(CELL_WIDTH * 4 - 1)).toBe(3);
  });

  it("never reports none, however narrow", () => {
    expect(columnsIn(0)).toBe(1);
    expect(columnsIn(10)).toBe(1);
  });
});

describe("visibleCells", () => {
  const cells = (count: number): FileCell[] =>
    Array.from({ length: count }, (_, i) => ({
      kind: "entry" as const,
      entry: entry(`f${i}.ts`),
      path: `f${i}.ts`,
    }));

  it("shows everything that fits, with nothing left over", () => {
    const window = visibleCells(cells(8), { width: CELL_WIDTH * 4, maxRows: 2 });
    expect(window.cells).toHaveLength(8);
    expect(window.overflow).toBe(0);
  });

  it("gives the last slot to the count once there are more than fit", () => {
    const window = visibleCells(cells(20), { width: CELL_WIDTH * 4, maxRows: 2 });
    // Seven names and a "+13 more" in the eighth slot: two rows, never a third.
    expect(window.cells).toHaveLength(7);
    expect(window.overflow).toBe(13);
    expect(window.cells.length + window.overflow).toBe(20);
  });

  it("holds to the row limit it is given", () => {
    expect(visibleCells(cells(20), { width: CELL_WIDTH * 4, maxRows: 1 }).cells).toHaveLength(3);
  });

  it("draws the count alone rather than one arbitrary name beside it", () => {
    const window = visibleCells(cells(5), { width: 10, maxRows: 1 });
    expect(window.cells).toEqual([]);
    expect(window.overflow).toBe(5);
  });

  it("counts the way out as a cell, because it takes a cell's place", () => {
    const withUp: FileCell[] = [{ kind: "up", label: "src", path: "" }, ...cells(7)];
    const window = visibleCells(withUp, { width: CELL_WIDTH * 4, maxRows: 2 });
    expect(window.overflow).toBe(0);
    expect(window.cells[0]).toEqual({ kind: "up", label: "src", path: "" });
  });

  it("keeps the way out even when the rest overflow", () => {
    const withUp: FileCell[] = [{ kind: "up", label: "src", path: "" }, ...cells(40)];
    const window = visibleCells(withUp, { width: CELL_WIDTH * 4, maxRows: 2 });
    expect(window.cells[0].kind).toBe("up");
    expect(window.overflow).toBe(34);
  });

  it("has nothing to say about an empty directory", () => {
    expect(visibleCells([], { width: CELL_WIDTH * 4 })).toEqual({ cells: [], overflow: 0 });
  });
});

describe("pruneCwd", () => {
  it("keeps what is still on the board", () => {
    const cwd = { [cwdKey("a1", "t1")]: "src", [cwdKey("a2", "t1")]: "docs" };
    expect(pruneCwd(cwd, ["a1", "a2"], ["t1"])).toEqual(cwd);
  });

  it("forgets where a removed frame was looking", () => {
    const cwd = { [cwdKey("a1", "t1")]: "src", [cwdKey("a2", "t1")]: "docs" };
    expect(pruneCwd(cwd, ["a1"], ["t1"])).toEqual({ [cwdKey("a1", "t1")]: "src" });
  });

  it("forgets a taskspace that is gone", () => {
    const cwd = { [cwdKey("a1", "t1")]: "src", [cwdKey("a1", "t2")]: "docs" };
    expect(pruneCwd(cwd, ["a1"], ["t2"])).toEqual({ [cwdKey("a1", "t2")]: "docs" });
  });

  it("leaves nothing behind when the board has no frames at all", () => {
    expect(pruneCwd({ [cwdKey("a1", "t1")]: "src" }, [], ["t1"])).toEqual({});
  });
});
