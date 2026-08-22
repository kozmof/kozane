import { describe, expect, it } from "vitest";
import { getAllBundles } from "../db/api/bundle.js";
import { getAllLayers } from "../db/api/layer.js";
import { getAllProjects } from "../db/api/project.js";
import type { DB } from "../db/tx.js";
import { createTestDB } from "../test-utils/db.js";
import { NAME_MAX } from "$lib/constants";
import { actions } from "./+page.server.js";

function submit(db: DB, name: string | null) {
  const body = new FormData();
  if (name !== null) body.set("name", name);
  const request = new Request("http://localhost/", { method: "POST", body });
  const create = actions?.default;
  if (!create) throw new Error("The create-project action is not exported");
  return create({ locals: { db }, request } as never);
}

describe("POST / (create project)", () => {
  it("creates a project with its default bundle and layer", async () => {
    const db = await createTestDB();

    expect(await submit(db, "  Browser project  ")).toEqual({ success: true });

    const [project] = await getAllProjects({ db });
    expect(project).toMatchObject({ name: "Browser project", isDefault: false });
    expect(await getAllBundles({ db, projectId: project.id })).toHaveLength(1);
    expect(await getAllLayers({ db, projectId: project.id })).toHaveLength(1);
  });

  it("rejects a missing name", async () => {
    const db = await createTestDB();

    expect(await submit(db, null)).toMatchObject({
      status: 400,
      data: { error: "Project name is required." },
    });
    expect(await getAllProjects({ db })).toEqual([]);
  });

  it("rejects a blank name", async () => {
    const db = await createTestDB();

    expect(await submit(db, "   ")).toMatchObject({
      status: 400,
      data: { error: "Project name is required." },
    });
    expect(await getAllProjects({ db })).toEqual([]);
  });

  it("rejects a name past the length limit", async () => {
    const db = await createTestDB();

    expect(await submit(db, "x".repeat(NAME_MAX + 1))).toMatchObject({
      status: 400,
      data: { error: `Project name must be ${NAME_MAX} characters or fewer.` },
    });
    expect(await getAllProjects({ db })).toEqual([]);
  });

  it("allows a name another project already uses, as the CLI does", async () => {
    const db = await createTestDB();

    await submit(db, "Twin");
    await submit(db, "Twin");

    expect((await getAllProjects({ db })).map(({ name }) => name)).toEqual(["Twin", "Twin"]);
  });
});
