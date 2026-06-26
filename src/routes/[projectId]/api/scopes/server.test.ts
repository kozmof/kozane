import { describe, expect, it } from "vitest";
import { getAllScopes } from "../../../../db/api/scope.js";
import { addProject } from "../../../../db/api/project.js";
import type { DB } from "../../../../db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/scopes", {
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

describe("POST /[projectId]/api/scopes", () => {
  it("creates a scope and returns its id", async () => {
    const { db, projectId } = await setup();

    const response = await POST(event(db, projectId, jsonRequest({ name: "  my-scope  " })));

    expect(response.status).toBe(200);
    const { id } = await response.json();
    expect(typeof id).toBe("string");

    const scopes = await getAllScopes({ db });
    expect(scopes).toHaveLength(1);
    expect(scopes[0].name).toBe("my-scope");
  });

  it("rejects a blank name", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "   " }))),
      400,
      "name is required",
    );
  });

  it("rejects a duplicate scope name", async () => {
    const { db, projectId } = await setup();
    await POST(event(db, projectId, jsonRequest({ name: "dup" })));

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "dup" }))),
      400,
      'A scope named "dup" already exists',
    );
  });
});
