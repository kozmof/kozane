import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TASKSPACE_MARKER_FILE, TASKSPACE_MARKER_KIND } from "../taskspace-marker.js";
import {
  enclosingTaskspaceDir,
  enclosingRecordedTaskspace,
  holdsOtherTaskspaces,
  claimTaskspaceDirectory,
  isManagedTaskspaceDirectory,
  makeParentsInside,
  missingDirs,
  moveTaskspaceDirectory,
  removeEmptyDirs,
  type ClaimRequest,
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
      placement: { defaultDir: "taskspaces", namespacePaths: {} },
      namespaces: [{ id: "019a0000-0000-7000-8000-000000000001", name: "work" }],
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

describe("enclosingRecordedTaskspace", () => {
  it("finds a recorded taskspace around a target outside the workspace", () => {
    const root = tempDir("kozane-root-");
    const outside = tempDir("kozane-outside-");
    const all = [
      { id: "abs", path: join(outside, "tasks"), pathKind: "absolute" as const },
      { id: "rel", path: "notes", pathKind: "workspace_relative" as const },
      { id: "none", path: null, pathKind: "workspace_relative" as const },
    ];
    expect(enclosingRecordedTaskspace(root, join(outside, "tasks", "Work", "a"), all)).toBe(
      join(outside, "tasks"),
    );
    expect(enclosingRecordedTaskspace(root, join(root, "notes", "a"), all)).toBe(
      join(root, "notes"),
    );
    // The taskspace's own directory, or a sibling, is not inside it.
    expect(enclosingRecordedTaskspace(root, join(outside, "tasks"), all)).toBeNull();
    expect(enclosingRecordedTaskspace(root, join(outside, "tasks-2", "a"), all)).toBeNull();
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

describe("isManagedTaskspaceDirectory with namespacePaths", () => {
  const check = (storedPath: string, defaultDir = "taskspaces") =>
    isManagedTaskspaceDirectory({
      workspaceRoot: "/work",
      storedPath,
      pathKind: "workspace_relative",
      placement: { defaultDir, namespacePaths: { aaaaaaa: "clients/acme", bbbbbbb: "/work/abs" } },
      namespaces: [{ id: "019a0000-0000-7000-8000-000000000001", name: "Work" }],
    });

  it("rejects a folder in defaultDir that is no current namespace's folder", () => {
    expect(check(join("taskspaces", "Other", "notes"))).toBe(false);
    // With defaultDir at the root, the user's own src/lib must stay out of reach.
    expect(check(join("src", "lib"), ".")).toBe(false);
    expect(check(join("Work", "notes"), ".")).toBe(true);
  });

  it("accepts a directory directly in defaultDir or in a namespace folder there", () => {
    expect(check(join("taskspaces", "notes"))).toBe(true);
    expect(check(join("taskspaces", "Work", "notes"))).toBe(true);
  });

  it("accepts a directory directly in a configured namespace path", () => {
    expect(check(join("clients", "acme", "notes"))).toBe(true);
    expect(check(join("abs", "notes"))).toBe(true);
  });

  it("rejects a directory elsewhere or nested deeper", () => {
    expect(check(join("src", "notes"))).toBe(false);
    expect(check(join("taskspaces", "Work", "deep", "notes"))).toBe(false);
    expect(check(join("clients", "acme", "deep", "notes"))).toBe(false);
  });
});

describe("claimTaskspaceDirectory", () => {
  const claim = (root: string, path: string, more: Partial<ClaimRequest> = {}) =>
    claimTaskspaceDirectory({
      workspaceRoot: root,
      targetDir: join(root, path),
      taskspaceId: "t1",
      namespaceId: "n1",
      adoptExisting: false,
      parentsInside: true,
      ownIfCreated: true,
      ...more,
    });
  const marker = (root: string, path: string) =>
    JSON.parse(readFileSync(join(root, path, TASKSPACE_MARKER_FILE), "utf-8"));

  it("makes the directory, its parents and an owning marker", () => {
    const root = tempDir("kozane-claim-");
    expect(claim(root, join("taskspaces", "main", "notes"))).toEqual({ dirCreated: true });
    expect(marker(root, join("taskspaces", "main", "notes"))).toMatchObject({
      kind: TASKSPACE_MARKER_KIND,
      taskspaceId: "t1",
      namespaceId: "n1",
      ownsDirectory: true,
    });
  });

  it("adopts an existing directory without claiming to own it", () => {
    const root = tempDir("kozane-claim-");
    mkdirSync(join(root, "mine"));
    writeFileSync(join(root, "mine", "keep.txt"), "x");
    expect(claim(root, "mine", { adoptExisting: true })).toEqual({ dirCreated: false });
    expect(marker(root, "mine").ownsDirectory).toBeUndefined();
  });

  it("refuses an existing directory unless adopting, and leaves it alone", () => {
    const root = tempDir("kozane-claim-");
    mkdirSync(join(root, "taken"));
    expect(() => claim(root, "taken")).toThrow(
      expect.objectContaining({ reason: "exists", message: "Taskspace directory already exists" }),
    );
    expect(readdirSync(join(root, "taken"))).toEqual([]);
  });

  it("refuses a directory that already holds a marker", () => {
    const root = tempDir("kozane-claim-");
    mkdirSync(join(root, "taken"));
    writeFileSync(join(root, "taken", TASKSPACE_MARKER_FILE), "original");
    expect(() => claim(root, "taken", { adoptExisting: true })).toThrow(
      expect.objectContaining({ reason: "exists" }),
    );
    expect(readFileSync(join(root, "taken", TASKSPACE_MARKER_FILE), "utf-8")).toBe("original");
  });

  it("refuses a parent that leads outside and leaves nothing behind", () => {
    const root = tempDir("kozane-claim-");
    const outside = tempDir("kozane-outside-");
    symlinkSync(outside, join(root, "taskspaces"));
    expect(() => claim(root, join("taskspaces", "main", "notes"))).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it("leaves a file at the target alone when the marker cannot be written", () => {
    const root = tempDir("kozane-claim-");
    // Adopting a file gets as far as the marker, which cannot go inside it.
    mkdirSync(join(root, "taskspaces"));
    writeFileSync(join(root, "taskspaces", "notes"), "not a dir");
    expect(() => claim(root, join("taskspaces", "notes"), { adoptExisting: true })).toThrow();
    expect(readFileSync(join(root, "taskspaces", "notes"), "utf-8")).toBe("not a dir");
  });
});
