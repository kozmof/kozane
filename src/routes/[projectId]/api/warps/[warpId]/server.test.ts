import { describe, expect, it } from "vitest";
import { addWarp, getAllWarps } from "../../../../../db/api/warp.js";
import { addProject } from "../../../../../db/api/project.js";
import type { DB } from "../../../../../db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE } from "./+server.js";

function event(db: DB, projectId: string, warpId: string) {
  return { locals: { db }, params: { projectId, warpId } } as never;
}

async function expectHttpRejection(value: unknown, status: number) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  return { db, projectId };
}

describe("DELETE /[projectId]/api/warps/[warpId]", () => {
  it("removes the warp", async () => {
    const { db, projectId } = await setup();
    const warp = await addWarp({ db, projectId, posX: 0, posY: 0 });

    const response = await DELETE(event(db, projectId, warp.id));

    expect(await response.json()).toEqual({ ok: true });
    expect(await getAllWarps({ db, projectId })).toEqual([]);
  });

  it("answers 404 for a warp that does not exist", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(DELETE(event(db, projectId, "missing")), 404);
  });

  it("answers 404 for a warp belonging to another project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const warp = await addWarp({ db, projectId, posX: 0, posY: 0 });

    await expectHttpRejection(DELETE(event(db, otherId, warp.id)), 404);
    expect(await getAllWarps({ db, projectId })).toMatchObject([{ id: warp.id }]);
  });
});
