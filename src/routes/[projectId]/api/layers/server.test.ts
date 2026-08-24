import { describe, expect, it } from "vitest";
import { addLayer, getAllLayers } from "$db/api/layer.js";
import { addProject } from "$db/api/project.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { PATCH, POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/layers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, request: Request) {
  return { locals: { db }, params: { projectId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  await addLayer({ db, projectId, name: "Base", isDefault: true });
  return { db, projectId };
}

describe("POST /[projectId]/api/layers", () => {
  it("creates a layer on top of the existing ones", async () => {
    const { db, projectId } = await setup();

    const response = await POST(event(db, projectId, jsonRequest({ name: "  Draft  " })));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "Draft", position: 1, isDefault: false });

    const layers = await getAllLayers({ db, projectId });
    expect(layers.map(({ name }) => name)).toEqual(["Base", "Draft"]);
  });

  it("rejects a blank name", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "   " }))),
      400,
      "name is required",
    );
  });

  it("rejects a duplicate layer name within the same project", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "Base" }))),
      400,
      'A layer named "Base" already exists',
    );
  });

  it("returns 404 for a nonexistent project", async () => {
    const { db } = await setup();

    await expectHttpRejection(
      POST(event(db, "nonexistent-project-id", jsonRequest({ name: "Draft" }))),
      404,
      "Project not found",
    );
  });
});

describe("PATCH /[projectId]/api/layers", () => {
  async function setupThree() {
    const { db, projectId } = await setup();
    const { id: draft } = await addLayer({ db, projectId, name: "Draft" });
    const { id: notes } = await addLayer({ db, projectId, name: "Notes" });
    const [base] = await getAllLayers({ db, projectId });
    return { db, projectId, base: base.id, draft, notes };
  }

  it("renumbers the layers from a full bottom-to-top ordering", async () => {
    const { db, projectId, base, draft, notes } = await setupThree();

    const response = await PATCH(
      event(db, projectId, jsonRequest({ layerIds: [notes, base, draft] })),
    );

    expect(response.status).toBe(200);
    expect((await getAllLayers({ db, projectId })).map(({ name }) => name)).toEqual([
      "Notes",
      "Base",
      "Draft",
    ]);
  });

  it("rejects a partial ordering without renumbering", async () => {
    const { db, projectId, base, draft } = await setupThree();

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ layerIds: [draft, base] }))),
      400,
      "The project's layers changed elsewhere. Reload to see the current order.",
    );
    expect((await getAllLayers({ db, projectId })).map(({ name }) => name)).toEqual([
      "Base",
      "Draft",
      "Notes",
    ]);
  });

  it("rejects an ordering naming a layer from another project", async () => {
    const { db, projectId, base, draft } = await setupThree();
    const otherProjectId = await addProject({ db, name: "Other" });
    const { id: foreign } = await addLayer({ db, projectId: otherProjectId, name: "Theirs" });

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ layerIds: [base, draft, foreign] }))),
      400,
      "layerIds must only name layers of this project",
    );
  });

  it("rejects an empty ordering", async () => {
    const { db, projectId } = await setupThree();

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ layerIds: [] }))),
      400,
      "layerIds must have at least 1 item",
    );
  });
});
