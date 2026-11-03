import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TASKSPACE_MARKER_FILE, TASKSPACE_MARKER_KIND } from "../taskspace-marker.js";
import {
  enclosingTaskspaceDir,
  holdsOtherTaskspaces,
  isManagedTaskspaceDirectory,
  makeParentsInside,
  missingDirs,
  moveTaskspaceDirectory,
  removeEmptyDirs,
} from "./taskspace-directory.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A directory Kozane created for taskspace `id` at `<root>/<path>`. */
function ownedDirectory(root: string, path: string, id: string): void {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(
    join(root, path, TASKSPACE_MARKER_FILE),
    JSON.stringify({ kind: TASKSPACE_MARKER_KIND, taskspaceId: id, ownsDirectory: true }),
  );
}

describe("missingDirs", () => {
  it("lists the missing directories deepest first", () => {
    const root = tempDir("kozane-dirs-");
    expect(missingDirs(join(root, "a", "b"))).toEqual([join(root, "a", "b"), join(root, "a")]);
    expect(missingDirs(root)).toEqual([]);
  });
});

describe("makeParentsInside", () => {
  it("creates the folders and returns them", () => {
    const root = tempDir("kozane-dirs-");
    const created = makeParentsInside(root, join(root, "taskspaces", "Work"));
    expect(created).toEqual([join(root, "taskspaces", "Work"), join(root, "taskspaces")]);
    expect(existsSync(join(root, "taskspaces", "Work"))).toBe(true);
  });

  it("creates nothing through a symlink that leads outside", () => {
    const root = tempDir("kozane-dirs-");
    const outside = tempDir("kozane-outside-");
    symlinkSync(outside, join(root, "taskspaces"));
    expect(makeParentsInside(root, join(root, "taskspaces", "Work"))).toBeNull();
    expect(existsSync(join(outside, "Work"))).toBe(false);
  });
});

describe("removeEmptyDirs", () => {
  it("stops at the first directory that is not empty", () => {
    const root = tempDir("kozane-dirs-");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "keep.txt"), "x");
    removeEmptyDirs([join(root, "a", "b"), join(root, "a")]);
    expect(existsSync(join(root, "a", "b"))).toBe(false);
    expect(existsSync(join(root, "a", "keep.txt"))).toBe(true);
  });
});

describe("moveTaskspaceDirectory", () => {
  it("refuses a target that already exists", () => {
    const root = tempDir("kozane-move-");
    ownedDirectory(root, "notes", "ts-1");
    mkdirSync(join(root, "taken", "notes", "inner"), { recursive: true });
    expect(() =>
      moveTaskspaceDirectory({
        workspaceRoot: root,
        storedPath: "notes",
        taskspaceId: "ts-1",
        nextStored: join("taken", "notes"),
      }),
    ).toThrow("already exists");
    expect(existsSync(join(root, "notes", TASKSPACE_MARKER_FILE))).toBe(true);
  });

  it("refuses a parent that is a symlink out of the workspace and creates nothing there", () => {
    const root = tempDir("kozane-move-");
    const outside = tempDir("kozane-outside-");
    ownedDirectory(root, "notes", "ts-1");
    symlinkSync(outside, join(root, "taskspaces"));

    expect(() =>
      moveTaskspaceDirectory({
        workspaceRoot: root,
        storedPath: "notes",
        taskspaceId: "ts-1",
        nextStored: join("taskspaces", "Work", "notes"),
      }),
    ).toThrow("inside the workspace root");
    expect(existsSync(join(outside, "Work"))).toBe(false);
    expect(existsSync(join(root, "notes", TASKSPACE_MARKER_FILE))).toBe(true);
  });

  it("removes the folders it made when the move fails", () => {
    const root = tempDir("kozane-move-");
    ownedDirectory(root, "notes", "ts-1");
    // Moving a directory into itself fails after `taskspaces/Work` would be made under it.
    expect(() =>
      moveTaskspaceDirectory({
        workspaceRoot: root,
        storedPath: "notes",
        taskspaceId: "ts-1",
        nextStored: join("notes", "Work", "notes"),
      }),
    ).toThrow();
    expect(existsSync(join(root, "notes", "Work"))).toBe(false);
    expect(existsSync(join(root, "notes", TASKSPACE_MARKER_FILE))).toBe(true);
  });
});

describe("isManagedTaskspaceDirectory", () => {
  const check = (storedPath: string) =>
    isManagedTaskspaceDirectory({
      workspaceRoot: "/ws",
      storedPath,
      pathKind: "workspace_relative",
      defaultDir: "taskspaces",
      namespacePaths: [],
      namespaceFolders: ["work"],
    });

  it("matches a namespace folder whatever its case", () => {
    // Such as after renaming "Work" to "work", which is the same folder on a
    // case-insensitive disk.
    expect(check(join("taskspaces", "Work", "notes"))).toBe(true);
    expect(check(join("taskspaces", "work", "notes"))).toBe(true);
    expect(check(join("taskspaces", "other", "notes"))).toBe(false);
  });
});

describe("enclosingTaskspaceDir", () => {
  it("finds the nearest folder above that holds a taskspace marker", () => {
    const root = tempDir("kozane-enclosing-");
    ownedDirectory(root, join("taskspaces", "Work"), "outer");
    expect(enclosingTaskspaceDir(root, join(root, "taskspaces", "Work", "deeper"))).toBe(
      join(root, "taskspaces", "Work"),
    );
    expect(enclosingTaskspaceDir(root, join(root, "taskspaces", "Other"))).toBeNull();
  });

  it("never looks at the workspace root or above it", () => {
    const root = tempDir("kozane-enclosing-");
    writeFileSync(join(root, TASKSPACE_MARKER_FILE), "{}");
    expect(enclosingTaskspaceDir(root, join(root, "taskspaces"))).toBeNull();
  });
});

describe("holdsOtherTaskspaces", () => {
  const row = (id: string, path: string | null) => ({
    id,
    path,
    pathKind: "workspace_relative" as const,
  });

  it("is true only when another taskspace sits strictly inside", () => {
    const root = tempDir("kozane-holds-");
    const outer = row("outer", join("taskspaces", "Work"));
    const inner = row("inner", join("taskspaces", "Work", "notes"));
    const sibling = row("sibling", join("taskspaces", "Work-2"));
    expect(holdsOtherTaskspaces(root, outer, [outer, inner, sibling])).toBe(true);
    expect(holdsOtherTaskspaces(root, outer, [outer, sibling, row("none", null)])).toBe(false);
    expect(holdsOtherTaskspaces(root, inner, [outer, inner])).toBe(false);
  });
});

describe("makeParentsInside with a dangling symlink", () => {
  it("returns null instead of throwing", () => {
    const root = tempDir("kozane-dangling-");
    symlinkSync(join(root, "gone"), join(root, "taskspaces"));
    expect(makeParentsInside(root, join(root, "taskspaces", "Work"))).toBeNull();
  });
});
