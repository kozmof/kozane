import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addProject,
  getProject,
  getAllProjects,
  deleteProject,
  updateProjectName,
} from "./project.js";
import { NotFoundError } from "./utils.js";

async function db() {
  return createTestDB();
}

describe("addProject", () => {
  it("returns a non-empty id", async () => {
    const d = await db();
    const id = await addProject({ db: d, name: "My Project" });
    expect(id).toBeTruthy();
  });

  it("assigns unique ids to each project", async () => {
    const d = await db();
    const id1 = await addProject({ db: d, name: "A" });
    const id2 = await addProject({ db: d, name: "B" });
    expect(id1).not.toBe(id2);
  });
});

describe("getProject", () => {
  it("returns the project with matching id", async () => {
    const d = await db();
    const id = await addProject({ db: d, name: "Test" });
    const project = await getProject({ db: d, projectId: id });
    expect(project).toEqual({ id, name: "Test" });
  });

  it("returns undefined for a missing id", async () => {
    const d = await db();
    expect(await getProject({ db: d, projectId: "no-such-id" })).toBeUndefined();
  });
});

describe("getAllProjects", () => {
  it("returns empty array when no projects exist", async () => {
    const d = await db();
    expect(await getAllProjects({ db: d })).toEqual([]);
  });

  it("returns all created projects", async () => {
    const d = await db();
    const id1 = await addProject({ db: d, name: "Alpha" });
    const id2 = await addProject({ db: d, name: "Beta" });
    const projects = await getAllProjects({ db: d });
    expect(projects.map((p) => p.id)).toEqual(expect.arrayContaining([id1, id2]));
    expect(projects).toHaveLength(2);
  });
});

describe("deleteProject", () => {
  it("removes the project so it can no longer be found", async () => {
    const d = await db();
    const id = await addProject({ db: d, name: "ToDelete" });
    await deleteProject({ db: d, projectId: id });
    expect(await getProject({ db: d, projectId: id })).toBeUndefined();
  });

  it("throws NotFoundError when project does not exist", async () => {
    const d = await db();
    await expect(deleteProject({ db: d, projectId: "ghost" })).rejects.toThrow(NotFoundError);
  });
});

describe("updateProjectName", () => {
  it("changes the project name", async () => {
    const d = await db();
    const id = await addProject({ db: d, name: "Old" });
    await updateProjectName({ db: d, projectId: id, name: "New" });
    const project = await getProject({ db: d, projectId: id });
    expect(project?.name).toBe("New");
  });

  it("throws NotFoundError when project does not exist", async () => {
    const d = await db();
    await expect(updateProjectName({ db: d, projectId: "ghost", name: "X" })).rejects.toThrow(
      NotFoundError,
    );
  });
});
