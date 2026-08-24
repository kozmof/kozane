import { describe, expect, it } from "vitest";
import { addWarp } from "$db/api/warp.js";
import { addProject } from "$db/api/project.js";
import { addBundle } from "$db/api/bundle.js";
import { addLayer } from "$db/api/layer.js";
import { addCard } from "$db/api/card.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { GET } from "./+server.js";

function event(db: DB, projectId: string) {
  return { locals: { db }, params: { projectId } } as never;
}

async function addProjectWithBoard(db: DB, name: string) {
  const projectId = await addProject({ db, name });
  await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "General" });
  return { projectId, bundleId };
}

async function setup() {
  const db = await createTestDB();
  const here = await addProjectWithBoard(db, "Here");
  const there = await addProjectWithBoard(db, "There");
  return { db, here, there };
}

describe("GET /[projectId]/api/warp-directory", () => {
  it("returns the other projects' warps, numbered and hinted", async () => {
    const { db, here, there } = await setup();
    await addWarp({ db, projectId: here.projectId, posX: 0, posY: 0 });
    await addWarp({ db, projectId: there.projectId, posX: 500, posY: 500 });
    await addWarp({ db, projectId: there.projectId, posX: 2000, posY: 2000 });
    await addCard({ db, bundleId: there.bundleId, content: "Umesao 1969", posX: 520, posY: 500 });

    const response = await GET(event(db, here.projectId));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([
      {
        projectId: there.projectId,
        projectName: "There",
        label: 1,
        posX: 500,
        posY: 500,
        hint: "Umesao 1969",
        isCurrent: false,
      },
      { projectId: there.projectId, label: 2, hint: null },
    ]);
  });

  it("leaves out the warps of the project asking", async () => {
    const { db, here } = await setup();
    await addWarp({ db, projectId: here.projectId, posX: 100, posY: 100 });

    expect(await (await GET(event(db, here.projectId))).json()).toEqual([]);
  });

  it("answers 404 for a project that does not exist", async () => {
    const { db } = await setup();

    await expect(Promise.resolve(GET(event(db, "missing")))).rejects.toMatchObject({
      status: 404,
      body: { message: "Project not found" },
    });
  });
});
