import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addTaskspace,
  getTaskspace,
  getAllTaskspaces,
  getTaskspacesInProject,
  updateTaskspace,
  deleteTaskspace,
} from "./taskspace.js";
import { addProject } from "./project.js";
import { addScope } from "./scope.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  const scopeId = await addScope({ db, name: "S" });
  return { db, projectId, scopeId };
}

describe("addTaskspace", () => {
  it("returns a non-empty id", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({ db, projectId, scopeId });
    expect(id).toBeTruthy();
  });

  it("stores the provided name and path", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({
      db,
      projectId,
      scopeId,
      name: "my-taskspace",
      path: "packages/core",
    });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.name).toBe("my-taskspace");
    expect(taskspace?.path).toBe("packages/core");
  });

  it("defaults name to empty string", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({ db, projectId, scopeId });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.name).toBe("");
  });

  it("defaults pathKind to project_relative", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({ db, projectId, scopeId });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.pathKind).toBe("project_relative");
  });

  it("stores lastSeenAt when provided", async () => {
    const { db, projectId, scopeId } = await setup();
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const id = await addTaskspace({ db, projectId, scopeId, lastSeenAt: now });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.lastSeenAt?.getTime()).toBe(now.getTime());
  });

  it("stores absolute pathKind when specified", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({ db, projectId, scopeId, pathKind: "absolute" });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.pathKind).toBe("absolute");
  });
});

describe("getTaskspace", () => {
  it("returns the taskspace by id", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({ db, projectId, scopeId, name: "wc1" });
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
    const { db, projectId, scopeId } = await setup();
    const id1 = await addTaskspace({ db, projectId, scopeId, name: "wc1" });
    const id2 = await addTaskspace({ db, projectId, scopeId, name: "wc2" });
    const all = await getAllTaskspaces({ db });
    expect(all.map((w) => w.id)).toEqual(expect.arrayContaining([id1, id2]));
    expect(all).toHaveLength(2);
  });
});

describe("updateTaskspace", () => {
  it("updates name", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({ db, projectId, scopeId, name: "old" });
    await updateTaskspace({ db, taskspaceId: id, name: "new" });
    expect((await getTaskspace({ db, taskspaceId: id }))?.name).toBe("new");
  });

  it("updates path and pathKind", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({ db, projectId, scopeId });
    await updateTaskspace({ db, taskspaceId: id, path: "/abs/path", pathKind: "absolute" });
    const taskspace = await getTaskspace({ db, taskspaceId: id });
    expect(taskspace?.path).toBe("/abs/path");
    expect(taskspace?.pathKind).toBe("absolute");
  });

  it("updates lastSeenAt", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({ db, projectId, scopeId });
    // SQLite stores timestamps as integer seconds, so floor to the nearest second
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
  it("removes the taskspace", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addTaskspace({ db, projectId, scopeId });
    await deleteTaskspace({ db, taskspaceId: id });
    expect(await getTaskspace({ db, taskspaceId: id })).toBeUndefined();
  });

  it("throws NotFoundError for a missing id", async () => {
    const { db } = await setup();
    await expect(deleteTaskspace({ db, taskspaceId: "ghost" })).rejects.toThrow(NotFoundError);
  });
});

describe("getTaskspacesInProject", () => {
  const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();

  async function twoProjects() {
    const d = await createTestDB();
    const p1 = await addProject({ db: d, name: "P1" });
    const p2 = await addProject({ db: d, name: "P2" });
    return { d, p1, p2 };
  }

  it("returns this project's taskspaces and not another project's", async () => {
    const { d, p1, p2 } = await twoProjects();
    await addTaskspace({ db: d, projectId: p1, name: "mine" });
    await addTaskspace({ db: d, projectId: p2, name: "theirs" });

    expect(names(await getTaskspacesInProject({ db: d, projectId: p1 }))).toEqual(["mine"]);
    expect(names(await getTaskspacesInProject({ db: d, projectId: p2 }))).toEqual(["theirs"]);
  });

  it("returns a taskspace with no project to every project", async () => {
    const { d, p1, p2 } = await twoProjects();
    // A reattach from a marker naming no project leaves project_id null; that row is
    // unplaced rather than somebody else's, so it must not be invisible everywhere.
    await addTaskspace({ db: d, name: "unassigned" });

    expect(names(await getTaskspacesInProject({ db: d, projectId: p1 }))).toEqual(["unassigned"]);
    expect(names(await getTaskspacesInProject({ db: d, projectId: p2 }))).toEqual(["unassigned"]);
  });

  it("returns an empty list for a project with nothing of its own", async () => {
    const { d, p1, p2 } = await twoProjects();
    await addTaskspace({ db: d, projectId: p2, name: "theirs" });

    expect(await getTaskspacesInProject({ db: d, projectId: p1 })).toEqual([]);
  });

  it("carries the scope attachment through", async () => {
    const { d, p1 } = await twoProjects();
    const scopeId = await addScope({ db: d, name: "S" });
    await addTaskspace({ db: d, projectId: p1, scopeId, name: "scoped" });

    const [row] = await getTaskspacesInProject({ db: d, projectId: p1 });
    expect(row.scopeId).toBe(scopeId);
  });
});
