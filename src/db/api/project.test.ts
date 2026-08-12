import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addProject,
  getProject,
  getAllProjects,
  deleteProject,
  updateProjectName,
  setDefaultProject,
} from "./project.js";
import { addBundle } from "./bundle.js";
import { addLayer } from "./layer.js";
import { addCard } from "./card.js";
import { glueCards } from "./glue.js";
import { glueTable } from "../schema.js";
import { NotFoundError } from "./utils.js";
import type { DB } from "../tx.js";

async function db() {
  return createTestDB();
}

/** A project holding two cards glued to each other. */
async function projectWithGluedCards(d: DB, name: string) {
  const projectId = await addProject({ db: d, name });
  await addLayer({ db: d, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db: d, projectId, name: "B" });
  const cardA = await addCard({ db: d, bundleId, content: "A" });
  const cardB = await addCard({ db: d, bundleId, content: "B" });
  const glueId = await glueCards({ db: d, cardIds: [cardA, cardB] });
  return { projectId, glueId };
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

describe("setDefaultProject", () => {
  it("changes the only default project", async () => {
    const d = await db();
    const first = await addProject({ db: d, name: "First", isDefault: true });
    const second = await addProject({ db: d, name: "Second" });
    await setDefaultProject({ db: d, projectId: second });
    expect(await getProject({ db: d, projectId: first })).toMatchObject({ isDefault: false });
    expect(await getProject({ db: d, projectId: second })).toMatchObject({ isDefault: true });
  });

  it("throws when the project does not exist without clearing the current default", async () => {
    const d = await db();
    const first = await addProject({ db: d, name: "First", isDefault: true });
    await expect(setDefaultProject({ db: d, projectId: "ghost" })).rejects.toThrow(NotFoundError);
    expect(await getProject({ db: d, projectId: first })).toMatchObject({ isDefault: true });
  });
});

describe("getProject", () => {
  it("returns the project with matching id", async () => {
    const d = await db();
    const id = await addProject({ db: d, name: "Test" });
    const project = await getProject({ db: d, projectId: id });
    expect(project).toEqual({ id, name: "Test", isDefault: false });
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

  it("promotes another project when the default is deleted", async () => {
    const d = await db();
    const first = await addProject({ db: d, name: "First", isDefault: true });
    const second = await addProject({ db: d, name: "Second" });
    await deleteProject({ db: d, projectId: first });
    expect(await getProject({ db: d, projectId: second })).toMatchObject({ isDefault: true });
  });

  it("throws NotFoundError when project does not exist", async () => {
    const d = await db();
    await expect(deleteProject({ db: d, projectId: "ghost" })).rejects.toThrow(NotFoundError);
  });

  it("promotes the oldest survivor when several could replace the default", async () => {
    // Repeated because the bug this guards against is an unordered `limit(1)`: a single run
    // can pick the right row by luck.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const d = await db();
      const first = await addProject({ db: d, name: "First", isDefault: true });
      const second = await addProject({ db: d, name: "Second" });
      await addProject({ db: d, name: "Third" });

      await deleteProject({ db: d, projectId: first });

      const survivors = await getAllProjects({ db: d });
      expect(survivors.find(({ isDefault }) => isDefault)?.id).toBe(second);
    }
  });

  it("removes the glue groups its cards leave behind", async () => {
    const d = await db();
    const { projectId } = await projectWithGluedCards(d, "Doomed");
    expect(await d.select().from(glueTable)).toHaveLength(1);

    await deleteProject({ db: d, projectId });

    // The cards cascade away without passing through glue.ts, so nothing else would ever
    // remove the group row they belonged to.
    expect(await d.select().from(glueTable)).toEqual([]);
  });

  it("leaves another project's glue groups alone", async () => {
    const d = await db();
    const doomed = await projectWithGluedCards(d, "Doomed");
    const kept = await projectWithGluedCards(d, "Kept");

    await deleteProject({ db: d, projectId: doomed.projectId });

    expect((await d.select().from(glueTable)).map(({ id }) => id)).toEqual([kept.glueId]);
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
