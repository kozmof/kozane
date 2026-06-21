import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addWorkingCopy,
  getWorkingCopy,
  getAllWorkingCopies,
  updateWorkingCopy,
  deleteWorkingCopy,
} from "./working-copy.js";
import { addProject } from "./project.js";
import { addScope } from "./scope.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  const scopeId = await addScope({ db, name: "S" });
  return { db, projectId, scopeId };
}

describe("addWorkingCopy", () => {
  it("returns a non-empty id", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({ db, projectId, scopeId });
    expect(id).toBeTruthy();
  });

  it("stores the provided name and path", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({
      db,
      projectId,
      scopeId,
      name: "my-wc",
      path: "packages/core",
    });
    const wc = await getWorkingCopy({ db, workingCopyId: id });
    expect(wc?.name).toBe("my-wc");
    expect(wc?.path).toBe("packages/core");
  });

  it("defaults name to empty string", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({ db, projectId, scopeId });
    const wc = await getWorkingCopy({ db, workingCopyId: id });
    expect(wc?.name).toBe("");
  });

  it("defaults pathKind to project_relative", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({ db, projectId, scopeId });
    const wc = await getWorkingCopy({ db, workingCopyId: id });
    expect(wc?.pathKind).toBe("project_relative");
  });

  it("stores absolute pathKind when specified", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({ db, projectId, scopeId, pathKind: "absolute" });
    const wc = await getWorkingCopy({ db, workingCopyId: id });
    expect(wc?.pathKind).toBe("absolute");
  });
});

describe("getWorkingCopy", () => {
  it("returns the working copy by id", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({ db, projectId, scopeId, name: "wc1" });
    const wc = await getWorkingCopy({ db, workingCopyId: id });
    expect(wc?.id).toBe(id);
    expect(wc?.scopeId).toBe(scopeId);
  });

  it("returns undefined for a missing id", async () => {
    const { db } = await setup();
    expect(await getWorkingCopy({ db, workingCopyId: "ghost" })).toBeUndefined();
  });
});

describe("getAllWorkingCopies", () => {
  it("returns empty array when none exist", async () => {
    const { db } = await setup();
    expect(await getAllWorkingCopies({ db })).toEqual([]);
  });

  it("returns all working copies", async () => {
    const { db, projectId, scopeId } = await setup();
    const id1 = await addWorkingCopy({ db, projectId, scopeId, name: "wc1" });
    const id2 = await addWorkingCopy({ db, projectId, scopeId, name: "wc2" });
    const all = await getAllWorkingCopies({ db });
    expect(all.map((w) => w.id)).toEqual(expect.arrayContaining([id1, id2]));
    expect(all).toHaveLength(2);
  });
});

describe("updateWorkingCopy", () => {
  it("updates name", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({ db, projectId, scopeId, name: "old" });
    await updateWorkingCopy({ db, workingCopyId: id, name: "new" });
    expect((await getWorkingCopy({ db, workingCopyId: id }))?.name).toBe("new");
  });

  it("updates path and pathKind", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({ db, projectId, scopeId });
    await updateWorkingCopy({ db, workingCopyId: id, path: "/abs/path", pathKind: "absolute" });
    const wc = await getWorkingCopy({ db, workingCopyId: id });
    expect(wc?.path).toBe("/abs/path");
    expect(wc?.pathKind).toBe("absolute");
  });

  it("updates lastSeenAt", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({ db, projectId, scopeId });
    // SQLite stores timestamps as integer seconds, so floor to the nearest second
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    await updateWorkingCopy({ db, workingCopyId: id, lastSeenAt: now });
    const wc = await getWorkingCopy({ db, workingCopyId: id });
    expect(wc?.lastSeenAt?.getTime()).toBe(now.getTime());
  });

  it("throws NotFoundError for a missing id", async () => {
    const { db } = await setup();
    await expect(updateWorkingCopy({ db, workingCopyId: "ghost", name: "x" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("deleteWorkingCopy", () => {
  it("removes the working copy", async () => {
    const { db, projectId, scopeId } = await setup();
    const id = await addWorkingCopy({ db, projectId, scopeId });
    await deleteWorkingCopy({ db, workingCopyId: id });
    expect(await getWorkingCopy({ db, workingCopyId: id })).toBeUndefined();
  });

  it("throws NotFoundError for a missing id", async () => {
    const { db } = await setup();
    await expect(deleteWorkingCopy({ db, workingCopyId: "ghost" })).rejects.toThrow(NotFoundError);
  });
});
