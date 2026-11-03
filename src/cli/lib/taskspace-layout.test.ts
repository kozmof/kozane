import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNamespace } from "../../db/api/namespace.js";
import { addTaskspace } from "../../db/api/taskspace.js";
import { TASKSPACE_MARKER_FILE, TASKSPACE_MARKER_KIND } from "../../lib/taskspace-marker.js";
import { createTestDB } from "../../test-utils/db.js";
import { readConfig } from "./config.js";
import { planTaskspaceLayout } from "./taskspace-layout.js";

const roots: string[] = [];
afterEach(() => {
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
  return { owned, plan };
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

    expect(await plan()).toEqual({ legacyDefaultDir: false, moves: [] });
  });
});
