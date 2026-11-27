import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addTaskspace,
  getTaskspace,
  getAllTaskspaces,
  getTaskspacesInNamespace,
  updateTaskspace,
  deleteTaskspace,
  getAllTaskspaceLocalMetadata,
} from "./taskspace.js";
import { addNamespace } from "./namespace.js";
import { addScope } from "./scope.js";
import { NotFoundError } from "./utils.js";
import { sql } from "drizzle-orm";
import { taskspaceTable, namespaceTable } from "../schema.js";
import { eq } from "drizzle-orm";

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "P" });
  const scopeId = await addScope({ db, name: "S" });
  return { db, namespaceId, scopeId };
}

describe("addTaskspace", () => {
  it("rolls back shared identity when local attachment insertion fails", async () => {
    const { db, namespaceId } = await setup();
    await expect(
      addTaskspace({
        db,
        namespaceId,
        name: "Uncommitted",
        path: "local",
        pathKind: null as never,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await getAllTaskspaces({ db })).toEqual([]);
    expect(await getAllTaskspaceLocalMetadata({ db })).toEqual([]);
  });
  it("returns a non-empty id", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({ db, namespaceId, scopeId });
    expect(id).toBeTruthy();
  });

  it("stores the provided name and path", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({
      db,
      namespaceId,
      scopeId,
      name: "my-taskspace",
      path: "packages/core",
    });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.name).toBe("my-taskspace");
    expect(taskspace?.path).toBe("packages/core");
  });

  it("defaults name to empty string", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({ db, namespaceId, scopeId });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.name).toBe("");
  });

  it("defaults pathKind to workspace_relative", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({ db, namespaceId, scopeId });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.pathKind).toBe("workspace_relative");
  });

  it("stores lastSeenAt when provided", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const id = await addTaskspace({ db, namespaceId, scopeId, lastSeenAt: now });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.lastSeenAt?.getTime()).toBe(now.getTime());
  });

  it("stores absolute pathKind when specified", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({ db, namespaceId, scopeId, pathKind: "absolute" });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.pathKind).toBe("absolute");
  });
});

describe("getTaskspace", () => {
  it("returns the taskspace by id", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({ db, namespaceId, scopeId, name: "wc1" });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.id).toBe(id);
    expect(taskspace?.scopeId).toBe(scopeId);
  });

  it("returns undefined for a missing id", async () => {
    const { db } = await setup();
    expect(await getTaskspace({ db, taskspaceId: "ghost" })).toBeUndefined();
  });
});

describe("getAllTaskspaces", () => {
  it("returns empty array when none exist", async () => {
    const { db } = await setup();
    expect(await getAllTaskspaces({ db })).toEqual([]);
  });

  it("returns all taskspaces", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id1 = await addTaskspace({ db, namespaceId, scopeId, name: "wc1" });
    const id2 = await addTaskspace({ db, namespaceId, scopeId, name: "wc2" });
    const all = await getAllTaskspaces({ db });
    expect(all.map((w) => w.id)).toEqual(expect.arrayContaining([id1, id2]));
    expect(all).toHaveLength(2);
  });
});

describe("updateTaskspace", () => {
  it("rolls back the label when an accompanying local metadata update fails", async () => {
    const { db, namespaceId } = await setup();
    const id = await addTaskspace({ db, namespaceId, name: "Before", path: "local" });
    const before = await getTaskspace({ db, taskspaceId: id });
    await expect(
      updateTaskspace({ db, taskspaceId: id, name: "After", pathKind: null as never }),
    ).rejects.toBeInstanceOf(Error);
    expect(await getTaskspace({ db, taskspaceId: id })).toEqual(before);
  });
  it("preserves shared timestamps for ordinary location, observation and unchanged-label updates", async () => {
    const { db, namespaceId } = await setup();
    const id = await addTaskspace({ db, namespaceId, name: "Label", path: "before" });
    await db.run(sql`UPDATE taskspace SET created_at=1000,updated_at=2000 WHERE id=${id}`);
    await updateTaskspace({ db, taskspaceId: id, path: "after", lastSeenAt: new Date(3000000) });
    await updateTaskspace({ db, taskspaceId: id, name: "Label" });
    expect(await getTaskspace({ db, taskspaceId: id })).toMatchObject({
      name: "Label",
      path: "after",
      lastSeenAt: new Date(3000000),
      createdAt: new Date(1000000),
      updatedAt: new Date(2000000),
    });
    await updateTaskspace({ db, taskspaceId: id, name: "Changed" });
    const changed = (await getTaskspace({ db, taskspaceId: id }))!;
    expect(changed.createdAt).toEqual(new Date(1000000));
    expect(changed.updatedAt.getTime()).toBeGreaterThan(2000000);
    expect(changed.lastSeenAt).toEqual(new Date(3000000));
  });

  it("updates name", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({ db, namespaceId, scopeId, name: "old" });
    await updateTaskspace({ db, taskspaceId: id, name: "new" });
    expect((await getTaskspace({ db, taskspaceId: id }))?.name).toBe("new");
  });

  it("updates path and pathKind", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({ db, namespaceId, scopeId });
    await updateTaskspace({ db, taskspaceId: id, path: "/abs/path", pathKind: "absolute" });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.path).toBe("/abs/path");
    expect(taskspace?.pathKind).toBe("absolute");
  });

  it("updates lastSeenAt", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({ db, namespaceId, scopeId });
    // Round down to whole seconds to match SQLite timestamp storage.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    await updateTaskspace({ db, taskspaceId: id, lastSeenAt: now });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.lastSeenAt?.getTime()).toBe(now.getTime());
  });

  it("throws NotFoundError for a missing id", async () => {
    const { db } = await setup();
    await expect(updateTaskspace({ db, taskspaceId: "ghost", name: "x" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("deleteTaskspace", () => {
  it("retains hidden local metadata through deletion, identity restoration and namespace cascades", async () => {
    const { db, namespaceId } = await setup();
    const id = await addTaskspace({
      db,
      namespaceId,
      name: "Label",
      path: "local",
      lastSeenAt: new Date(100000),
    });
    const local = await getAllTaskspaceLocalMetadata({ db });
    await deleteTaskspace({ db, taskspaceId: id });
    expect(await getAllTaskspaces({ db })).toEqual([]);
    expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
    await db.insert(taskspaceTable).values({ id, namespaceId, name: "Restored" });
    expect(await getTaskspace({ db, taskspaceId: id })).toMatchObject({
      name: "Restored",
      path: "local",
      lastSeenAt: new Date(100000),
    });
    await db.delete(namespaceTable).where(eq(namespaceTable.id, namespaceId));
    expect(await getAllTaskspaces({ db })).toEqual([]);
    expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
  });
  it("removes the taskspace", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const id = await addTaskspace({ db, namespaceId, scopeId });
    await deleteTaskspace({ db, taskspaceId: id });
    expect(await getTaskspace({ db, taskspaceId: id })).toBeUndefined();
  });

  it("throws NotFoundError for a missing id", async () => {
    const { db } = await setup();
    await expect(deleteTaskspace({ db, taskspaceId: "ghost" })).rejects.toThrow(NotFoundError);
  });
});

describe("getTaskspacesInNamespace", () => {
  const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();

  async function twoNamespaces() {
    const d = await createTestDB();
    const p1 = await addNamespace({ db: d, name: "P1" });
    const p2 = await addNamespace({ db: d, name: "P2" });
    return { d, p1, p2 };
  }

  it("returns this namespace's taskspaces and not another namespace's", async () => {
    const { d, p1, p2 } = await twoNamespaces();
    await addTaskspace({ db: d, namespaceId: p1, name: "mine" });
    await addTaskspace({ db: d, namespaceId: p2, name: "theirs" });

    expect(names(await getTaskspacesInNamespace({ db: d, namespaceId: p1 }))).toEqual(["mine"]);
    expect(names(await getTaskspacesInNamespace({ db: d, namespaceId: p2 }))).toEqual(["theirs"]);
  });

  it("returns a taskspace with no namespace to every namespace", async () => {
    const { d, p1, p2 } = await twoNamespaces();
    // Show reattached taskspaces with no namespace on every board.
    await addTaskspace({ db: d, name: "unassigned" });

    expect(names(await getTaskspacesInNamespace({ db: d, namespaceId: p1 }))).toEqual([
      "unassigned",
    ]);
    expect(names(await getTaskspacesInNamespace({ db: d, namespaceId: p2 }))).toEqual([
      "unassigned",
    ]);
  });

  it("returns an empty list for a namespace with nothing of its own", async () => {
    const { d, p1, p2 } = await twoNamespaces();
    await addTaskspace({ db: d, namespaceId: p2, name: "theirs" });

    expect(await getTaskspacesInNamespace({ db: d, namespaceId: p1 })).toEqual([]);
  });

  it("carries the scope attachment through", async () => {
    const { d, p1 } = await twoNamespaces();
    const scopeId = await addScope({ db: d, name: "S" });
    await addTaskspace({ db: d, namespaceId: p1, scopeId, name: "scoped" });

    const [row] = await getTaskspacesInNamespace({ db: d, namespaceId: p1 });
    expect(row.scopeId).toBe(scopeId);
  });
});
