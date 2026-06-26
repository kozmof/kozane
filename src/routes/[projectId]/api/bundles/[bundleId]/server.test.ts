import { describe, expect, it } from "vitest";
import { addBundle, getAllBundles } from "../../../../../db/api/bundle.js";
import { addCard, getAllCards } from "../../../../../db/api/card.js";
import { addProject } from "../../../../../db/api/project.js";
import type { DB } from "../../../../../db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE, PATCH } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/bundles/bundle-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, bundleId: string, request: Request) {
  return { locals: { db }, params: { projectId, bundleId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  const defaultBundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "Extra" });
  return { db, projectId, defaultBundleId, bundleId };
}

describe("PATCH /[projectId]/api/bundles/[bundleId]", () => {
  it("renames a bundle", async () => {
    const { db, projectId, bundleId } = await setup();

    const response = await PATCH(
      event(db, projectId, bundleId, jsonRequest({ name: "  Renamed  " })),
    );

    expect(response.status).toBe(200);
    const bundles = await getAllBundles({ db, projectId });
    const updated = bundles.find((b) => b.id === bundleId);
    expect(updated?.name).toBe("Renamed");
  });

  it("rejects a blank name", async () => {
    const { db, projectId, bundleId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, bundleId, jsonRequest({ name: "   " }))),
      400,
      "name is required",
    );
  });

  it("rejects a duplicate name within the same project", async () => {
    const { db, projectId, bundleId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, bundleId, jsonRequest({ name: "General" }))),
      400,
      'A bundle named "General" already exists',
    );
  });

  it("returns 404 for a bundle not in the project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });

    await expectHttpRejection(
      PATCH(event(db, projectId, otherBundle, jsonRequest({ name: "Hacked" }))),
      404,
      `Bundle projectId=${projectId} bundleId=${otherBundle} not found`,
    );
  });
});

describe("DELETE /[projectId]/api/bundles/[bundleId]", () => {
  it("deletes a non-default bundle and reassigns its cards to the default", async () => {
    const { db, projectId, defaultBundleId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "Orphan" });

    const response = await DELETE(event(db, projectId, bundleId, new Request("http://localhost/")));

    expect(response.status).toBe(200);
    const { defaultBundleId: returned } = await response.json();
    expect(returned).toBe(defaultBundleId);

    const remaining = await getAllBundles({ db, projectId });
    expect(remaining.find((b) => b.id === bundleId)).toBeUndefined();

    const defaultCards = await getAllCards({ db, bundleId: defaultBundleId });
    expect(defaultCards).toHaveLength(1);
  });

  it("rejects deleting the default bundle", async () => {
    const { db, projectId, defaultBundleId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, projectId, defaultBundleId, new Request("http://localhost/"))),
      400,
      "Cannot delete the default bundle",
    );
  });

  it("returns 404 for a bundle not in the project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X", isDefault: true });

    await expectHttpRejection(
      DELETE(event(db, projectId, otherBundle, new Request("http://localhost/"))),
      404,
      `Bundle projectId=${projectId} bundleId=${otherBundle} not found`,
    );
  });
});
