import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TASKSPACE_MARKER_FILE, TASKSPACE_MARKER_KIND } from "../taskspace-marker.js";
import {
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
