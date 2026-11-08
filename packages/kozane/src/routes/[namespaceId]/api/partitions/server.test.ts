import { describe, expect, it } from "vitest";
import { getAllPartitions } from "$db/api/partition.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/partitions", {
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

describe("POST /[namespaceId]/api/partitions", () => {
  it("creates a partition and returns its id", async () => {
    const { db, namespaceId } = await setup();

    const response = await POST(event(db, namespaceId, jsonRequest({ name: "  My Partition  " })));

    expect(response.status).toBe(200);
    const { id } = await response.json();
    expect(typeof id).toBe("string");

    const partitions = await getAllPartitions({ db, namespaceId });
    expect(partitions).toHaveLength(1);
    expect(partitions[0].name).toBe("My Partition");
  });

  it("rejects a blank name", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ name: "   " }))),
      400,
      "name is required",
    );
  });

  it("rejects a duplicate partition name within the same namespace", async () => {
    const { db, namespaceId } = await setup();
    await POST(event(db, namespaceId, jsonRequest({ name: "Dup" })));

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ name: "Dup" }))),
      400,
      'A partition named "Dup" already exists',
    );
  });

  it("returns 404 for a nonexistent namespace", async () => {
    const { db } = await setup();

    await expectHttpRejection(
      POST(event(db, "nonexistent-namespace-id", jsonRequest({ name: "Partition" }))),
      404,
      "Namespace not found",
    );
  });
});
