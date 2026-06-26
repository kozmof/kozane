import { describe, expect, it } from "vitest";
import { getAllBundles } from "../../../../db/api/bundle.js";
import { addProject } from "../../../../db/api/project.js";
import type { DB } from "../../../../db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/bundles", {
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
  return { db, projectId };
}

describe("POST /[projectId]/api/bundles", () => {
  it("creates a bundle and returns its id", async () => {
    const { db, projectId } = await setup();

    const response = await POST(event(db, projectId, jsonRequest({ name: "  My Bundle  " })));

    expect(response.status).toBe(200);
    const { id } = await response.json();
    expect(typeof id).toBe("string");

    const bundles = await getAllBundles({ db, projectId });
    expect(bundles).toHaveLength(1);
    expect(bundles[0].name).toBe("My Bundle");
  });

  it("rejects a blank name", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "   " }))),
      400,
      "name is required",
    );
  });

  it("rejects a duplicate bundle name within the same project", async () => {
    const { db, projectId } = await setup();
    await POST(event(db, projectId, jsonRequest({ name: "Dup" })));

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "Dup" }))),
      400,
      'A bundle named "Dup" already exists',
    );
  });

  it("returns 404 for a nonexistent project", async () => {
    const { db } = await setup();

    await expectHttpRejection(
      POST(event(db, "nonexistent-project-id", jsonRequest({ name: "Bundle" }))),
      404,
      "Project not found",
    );
  });
});
