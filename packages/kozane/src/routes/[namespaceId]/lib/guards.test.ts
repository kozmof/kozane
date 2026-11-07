import { describe, it, expect } from "vitest";
import { requireCardInNamespace } from "./guards.js";
import { createTestDB } from "../../../test-utils/db.js";
import { addNamespace } from "$db/api/namespace.js";
import { addPartition } from "$db/api/partition.js";
import { addCard } from "$db/api/card.js";
import { addLayer } from "$db/api/layer.js";

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Test Namespace" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General" });
  const cardId = await addCard({ db, partitionId, content: "hello" });
  return { db, namespaceId, partitionId, cardId };
}

describe("requireCardInNamespace", () => {
  it("returns card id and partitionId when card belongs to namespace", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();
    const result = await requireCardInNamespace(db, namespaceId, cardId);
    expect(result).toEqual({ id: cardId, partitionId });
  });

  it("throws 404 when card exists but belongs to a different namespace", async () => {
    const { db, cardId } = await setup();
    const otherId = await addNamespace({ db, name: "Other Namespace" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    await expect(requireCardInNamespace(db, otherId, cardId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws 404 when card does not exist", async () => {
    const { db, namespaceId } = await setup();
    await expect(requireCardInNamespace(db, namespaceId, "no-such-card")).rejects.toMatchObject({
      status: 404,
    });
  });
});
