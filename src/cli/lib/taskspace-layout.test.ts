import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNamespace } from "../../db/api/namespace.js";
import { addTaskspace } from "../../db/api/taskspace.js";
import { TASKSPACE_MARKER_FILE, TASKSPACE_MARKER_KIND } from "../../lib/taskspace-marker.js";
import { createTestDB } from "../../test-utils/db.js";
import { readConfig } from "./config.js";
import {
  applyTaskspaceLayout,
  describeSkips,
  layoutIsOld,
  planTaskspaceLayout,
} from "./taskspace-layout.js";

/** Make the next record update fail, after running `before`, to test the undo. */
const updateFailure = vi.hoisted(() => ({
  next: undefined as { before?: () => void } | undefined,
}));
vi.mock("../../db/api/taskspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/api/taskspace.js")>();
  return {
    ...actual,
    updateTaskspace: async (args: Parameters<typeof actual.updateTaskspace>[0]) => {
      const failure = updateFailure.next;
      if (failure) {
        updateFailure.next = undefined;
        failure.before?.();
        throw new Error("database is locked");
      }
      return actual.updateTaskspace(args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  updateFailure.next = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function workspace(taskspace: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "kozane-layout-"));
  roots.push(root);
  mkdirSync(join(root, ".kozane"));
  writeFileSync(
    join(root, ".kozane", "config.json"),
    JSON.stringify({ name: "demo", taskspace: { searchRoots: ["."], ...taskspace } }),
  );
  const db = await createTestDB();
  const namespaceId = await createNamespace({ db, name: "main", isDefault: true });
  /** A taskspace whose directory Kozane created at `path`. */
  const owned = async (path: string) => {
    const id = await addTaskspace({ db, namespaceId, name: path, path });
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(
      join(root, path, TASKSPACE_MARKER_FILE),
      JSON.stringify({ kind: TASKSPACE_MARKER_KIND, taskspaceId: id, ownsDirectory: true }),
    );
  };
  const plan = () => planTaskspaceLayout(db, root, readConfig(root));
  return { db, root, namespaceId, owned, plan };
}

describe("planTaskspaceLayout", () => {
  it("marks directories a legacy defaultDir put at the root or in its namespace folders", async () => {
    const { owned, plan } = await workspace({ defaultDir: "." });
    await owned("notes");
    await owned(join("main", "draft"));
    await owned(join("elsewhere", "misc"));

    const { legacyDefaultDir, moves } = await plan();
    expect(legacyDefaultDir).toBe(true);
    expect(moves.map(({ from, to, oldLayout }) => ({ from, to, oldLayout }))).toEqual([
      { from: "notes", to: join("taskspaces", "main", "notes"), oldLayout: true },
      { from: join("main", "draft"), to: join("taskspaces", "main", "draft"), oldLayout: true },
      // Not a place the legacy config ever put a taskspace, so it does not block open.
      {
        from: join("elsewhere", "misc"),
        to: join("taskspaces", "main", "misc"),
        oldLayout: false,
      },
    ]);
  });

  it("does not mark a directory that is out of place under a current config", async () => {
    const { owned, plan } = await workspace({ defaultDir: "taskspaces", namespaceDirs: false });
    await owned(join("taskspaces", "main", "notes"));

    const { legacyDefaultDir, moves } = await plan();
    expect(legacyDefaultDir).toBe(false);
    expect(moves).toMatchObject([
      {
        from: join("taskspaces", "main", "notes"),
        to: join("taskspaces", "notes"),
        oldLayout: false,
      },
    ]);
  });

  it("treats a legacy defaultDir with namespaceDirs set as a chosen layout", async () => {
    const { owned, plan } = await workspace({ defaultDir: ".", namespaceDirs: false });
    await owned("notes");

    expect(await plan()).toEqual({ legacyDefaultDir: false, moves: [], skipped: [] });
  });
});

describe("layoutIsOld", () => {
  it("is true only for the legacy config or a directory where it put one", async () => {
    const legacy = await workspace({ defaultDir: "." });
    await legacy.owned("notes");
    expect(layoutIsOld(await legacy.plan())).toBe(true);

    // Out of place, such as after a rename, but not the old layout.
    const current = await workspace({ defaultDir: "taskspaces", namespaceDirs: false });
    await current.owned(join("taskspaces", "main", "notes"));
    const plan = await current.plan();
    expect(plan.moves).toHaveLength(1);
    expect(layoutIsOld(plan)).toBe(false);
  });
});

describe("applyTaskspaceLayout", () => {
  const defaultDir = (root: string) =>
    JSON.parse(readFileSync(join(root, ".kozane", "config.json"), "utf-8")).taskspace.defaultDir;

  it("moves the directories, then updates the config", async () => {
    const { db, root, owned, plan } = await workspace({ defaultDir: "." });
    await owned("notes");

    const result = await applyTaskspaceLayout(db, root, await plan());
    expect(result).toMatchObject({ config: "updated", failed: [] });
    expect(defaultDir(root)).toBe("taskspaces");
    expect(existsSync(join(root, "taskspaces", "main", "notes", TASKSPACE_MARKER_FILE))).toBe(true);
  });

  it("keeps the legacy config while a move fails, so open still refuses", async () => {
    const { db, root, owned, plan } = await workspace({ defaultDir: "." });
    await owned("notes");
    await owned("draft");
    mkdirSync(join(root, "taskspaces", "main", "draft", "inner"), { recursive: true });

    const result = await applyTaskspaceLayout(db, root, await plan());
    expect(result.moved.map(({ from }) => from)).toEqual(["notes"]);
    expect(result.failed.map(({ move }) => move.from)).toEqual(["draft"]);
    expect(result).toMatchObject({ config: "kept" });
    expect(result.failed[0].reason).toContain(
      `${join("taskspaces", "main", "draft")} already exists. Move it aside, or rename draft`,
    );
    expect(defaultDir(root)).toBe(".");

    // The moved one counts as in place, and only the failed one is still to move.
    const again = await plan();
    expect(again.moves.map(({ from, oldLayout }) => ({ from, oldLayout }))).toEqual([
      { from: "draft", oldLayout: true },
    ]);
  });

  it("moves a directory whose target is inside it, such as one named taskspaces", async () => {
    const { db, root, owned, plan } = await workspace({ defaultDir: "." });
    await owned("taskspaces");

    const planned = await plan();
    expect(planned.moves).toMatchObject([
      { from: "taskspaces", to: join("taskspaces", "main", "taskspaces") },
    ]);
    const result = await applyTaskspaceLayout(db, root, planned);
    expect(result).toMatchObject({ config: "updated", failed: [] });
    const moved = join(root, "taskspaces", "main", "taskspaces");
    expect(existsSync(join(moved, TASKSPACE_MARKER_FILE))).toBe(true);
    // Nothing is left beside it from moving it aside.
    expect(readdirSync(root).sort()).toEqual([".kozane", "taskspaces"]);
    expect((await plan()).moves).toEqual([]);
  });

  it("names the in-between path when it is what blocks a move through it", async () => {
    const { db, root, owned, plan } = await workspace({ defaultDir: "." });
    await owned("taskspaces");
    const planned = await plan();
    const [{ taskspaceId }] = planned.moves;
    const aside = `taskspaces.kozane-move-${taskspaceId.replaceAll("-", "").slice(-12, -5)}`;
    mkdirSync(join(root, aside, "inner"), { recursive: true });

    const result = await applyTaskspaceLayout(db, root, planned);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain(`${aside} already exists`);
    expect(result.failed[0].reason).not.toContain(join("taskspaces", "main", "taskspaces"));
    expect(existsSync(join(root, "taskspaces", TASKSPACE_MARKER_FILE))).toBe(true);
  });

  it("puts the directory back when its record cannot be updated", async () => {
    const { db, root, owned, plan } = await workspace({ defaultDir: "." });
    await owned("notes");
    updateFailure.next = {};

    const result = await applyTaskspaceLayout(db, root, await plan());
    expect(result.failed).toMatchObject([{ reason: "database is locked" }]);
    expect(result.config).toBe("kept");
    expect(existsSync(join(root, "notes", TASKSPACE_MARKER_FILE))).toBe(true);
    // The folders the move made are gone too.
    expect(existsSync(join(root, "taskspaces"))).toBe(false);
  });

  it("goes on with the other moves when putting a directory back fails", async () => {
    const { db, root, owned, plan } = await workspace({ defaultDir: "." });
    await owned("draft");
    await owned("notes");
    // Something takes the old path while the record update is running.
    updateFailure.next = {
      before: () => mkdirSync(join(root, "draft", "taken"), { recursive: true }),
    };

    const result = await applyTaskspaceLayout(db, root, await plan());
    expect(result.failed.map(({ move }) => move.from)).toEqual(["draft"]);
    expect(result.failed[0].reason).toContain("Could not move it back");
    expect(result.failed[0].reason).toContain("kozane taskspace scan --apply");
    expect(result.moved.map(({ from }) => from)).toEqual(["notes"]);
    expect(result.config).toBe("kept");
  });
});

describe("nested taskspaces", () => {
  it("moves a legacy taskspace named taskspaces before the ones going under it", async () => {
    const { db, root, owned, plan } = await workspace({ defaultDir: "." });
    await owned("notes");
    await owned("taskspaces");

    const planned = await plan();
    expect(planned.moves.map(({ from }) => from)).toEqual(["taskspaces", "notes"]);
    const result = await applyTaskspaceLayout(db, root, planned);
    expect(result).toMatchObject({ config: "updated", failed: [] });
    expect(existsSync(join(root, "taskspaces", "main", "notes", TASKSPACE_MARKER_FILE))).toBe(true);
    expect(existsSync(join(root, "taskspaces", "main", "taskspaces", TASKSPACE_MARKER_FILE))).toBe(
      true,
    );
    // The old `taskspaces` taskspace no longer holds the new folders.
    expect(existsSync(join(root, "taskspaces", TASKSPACE_MARKER_FILE))).toBe(false);
  });

  it("skips a move whose target is inside a taskspace that stays", async () => {
    const { db, root, namespaceId, owned, plan } = await workspace({ defaultDir: "taskspaces" });
    // The user's own directory, adopted as a taskspace, where the namespace folder would go.
    const id = await addTaskspace({
      db,
      namespaceId,
      name: "main",
      path: join("taskspaces", "main"),
    });
    mkdirSync(join(root, "taskspaces", "main"), { recursive: true });
    writeFileSync(
      join(root, "taskspaces", "main", TASKSPACE_MARKER_FILE),
      JSON.stringify({ kind: TASKSPACE_MARKER_KIND, taskspaceId: id }),
    );
    await owned(join("elsewhere", "notes"));

    const { moves, skipped } = await plan();
    expect(moves).toEqual([]);
    expect(skipped).toMatchObject([
      {
        move: { from: join("elsewhere", "notes") },
        reason: `its target would be inside the taskspace at ${join("taskspaces", "main")}`,
      },
    ]);
  });

  it("skips a move whose target is inside where another move puts a taskspace", async () => {
    const { db, root, owned, plan } = await workspace({ defaultDir: "taskspaces" });
    await owned(join("elsewhere", "foo"));
    // A second namespace whose path points inside `foo`'s new directory.
    const otherId = await createNamespace({ db, name: "other" });
    const barId = await addTaskspace({
      db,
      namespaceId: otherId,
      name: "bar",
      path: join("elsewhere", "bar"),
    });
    mkdirSync(join(root, "elsewhere", "bar"), { recursive: true });
    writeFileSync(
      join(root, "elsewhere", "bar", TASKSPACE_MARKER_FILE),
      JSON.stringify({ kind: TASKSPACE_MARKER_KIND, taskspaceId: barId, ownsDirectory: true }),
    );
    writeFileSync(
      join(root, ".kozane", "config.json"),
      JSON.stringify({
        name: "demo",
        taskspace: {
          searchRoots: ["."],
          defaultDir: "taskspaces",
          namespacePaths: { [otherId]: join("taskspaces", "main", "foo") },
        },
      }),
    );

    // Only `foo` moves; `bar` would land inside it.
    const { moves, skipped } = await plan();
    expect(moves.map(({ from }) => from)).toEqual([join("elsewhere", "foo")]);
    expect(skipped).toMatchObject([
      {
        move: { from: join("elsewhere", "bar") },
        reason: `its target would be inside the taskspace at ${join("taskspaces", "main", "foo")}`,
      },
    ]);
  });

  it("does not move a directory that holds another taskspace", async () => {
    const { owned, plan } = await workspace({ defaultDir: "taskspaces", namespaceDirs: false });
    await owned(join("elsewhere", "outer"));
    await owned(join("elsewhere", "outer", "inner"));

    // Only the inner one moves; the outer one would carry it along.
    const { moves, skipped } = await plan();
    expect(moves.map(({ from }) => from)).toEqual([join("elsewhere", "outer", "inner")]);
    expect(skipped).toMatchObject([
      { move: { from: join("elsewhere", "outer") }, reason: "it holds another taskspace" },
    ]);
  });

  it("lists an owned directory whose target is outside the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "kozane-outside-"));
    roots.push(outside);
    const { owned, plan } = await workspace({ defaultDir: outside, namespaceDirs: false });
    await owned(join("taskspaces", "notes"));

    const { moves, skipped } = await plan();
    expect(moves).toEqual([]);
    expect(skipped).toMatchObject([
      {
        move: { from: join("taskspaces", "notes"), to: join(outside, "notes") },
        reason: "its target is outside the workspace",
      },
    ]);
    expect(describeSkips(skipped)).toEqual([
      `  ${join("taskspaces", "notes")} stays: its target is outside the workspace`,
    ]);
  });

  it("still reports a directory it could not move after the legacy config is rewritten", async () => {
    const { root, db, owned, plan } = await workspace({ defaultDir: "." });
    await owned("outer");
    await owned(join("outer", "inner"));

    const planned = await plan();
    expect(planned.skipped).toMatchObject([
      { move: { from: "outer", oldLayout: true }, reason: "it holds another taskspace" },
    ]);
    const result = await applyTaskspaceLayout(db, root, planned);
    expect(result.config).toBe("updated");
    // With `inner` moved out, `outer` holds nothing, so it is now a move a second --fix makes.
    const again = await plan();
    expect(again.skipped).toEqual([]);
    expect(again.moves.map(({ from }) => from)).toEqual(["outer"]);
  });
});
