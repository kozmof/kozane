import { describe, expect, it } from "vitest";
import { addLayer, getAllLayers } from "../../../../db/api/layer.js";
import { addProject } from "../../../../db/api/project.js";
import type { DB } from "../../../../db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { POST } from "./+server.js";

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
