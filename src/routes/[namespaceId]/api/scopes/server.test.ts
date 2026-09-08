import { describe, expect, it } from "vitest";
import { getAllScopes } from "$db/api/scope.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/scopes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, namespaceId: string, request: Request) {
  return { locals: { db }, params: { namespaceId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  return { db, namespaceId };
}

describe("POST /[namespaceId]/api/scopes", () => {
  it("creates a scope and returns its id", async () => {
    const { db, namespaceId } = await setup();

    const response = await POST(event(db, namespaceId, jsonRequest({ name: "  my-scope  " })));

    expect(response.status).toBe(200);
    const { id } = await response.json();
    expect(typeof id).toBe("string");

    const scopes = await getAllScopes({ db });
    expect(scopes).toHaveLength(1);
    expect(scopes[0].name).toBe("my-scope");
  });

  it("rejects a blank name", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ name: "   " }))),
      400,
      "name is required",
    );
  });

  it("rejects a duplicate scope name", async () => {
    const { db, namespaceId } = await setup();
    await POST(event(db, namespaceId, jsonRequest({ name: "dup" })));

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ name: "dup" }))),
      400,
      'A scope named "dup" already exists',
    );
  });
});
