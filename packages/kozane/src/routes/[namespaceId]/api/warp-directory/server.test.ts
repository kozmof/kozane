import { describe, expect, it } from "vitest";
import { addWarp } from "$db/api/warp.js";
import { addNamespace } from "$db/api/namespace.js";
import { addPartition } from "$db/api/partition.js";
import { addLayer } from "$db/api/layer.js";
import { addCard } from "$db/api/card.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { GET } from "./+server.js";

function event(db: DB, namespaceId: string) {
  return { locals: { db }, params: { namespaceId } } as never;
}

async function addNamespaceWithBoard(db: DB, name: string) {
  const namespaceId = await addNamespace({ db, name });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General" });
  return { namespaceId, partitionId };
}

async function setup() {
  const db = await createTestDB();
  const here = await addNamespaceWithBoard(db, "Here");
  const there = await addNamespaceWithBoard(db, "There");
  return { db, here, there };
}

describe("GET /[namespaceId]/api/warp-directory", () => {
  it("returns the other namespaces' warps, numbered and hinted", async () => {
    const { db, here, there } = await setup();
    await addWarp({ db, namespaceId: here.namespaceId, posX: 0, posY: 0 });
    await addWarp({ db, namespaceId: there.namespaceId, posX: 500, posY: 500 });
    await addWarp({ db, namespaceId: there.namespaceId, posX: 2000, posY: 2000 });
    await addCard({
      db,
      partitionId: there.partitionId,
      content: "Umesao 1969",
      posX: 520,
      posY: 500,
    });

    const response = await GET(event(db, here.namespaceId));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([
      {
        namespaceId: there.namespaceId,
        namespaceName: "There",
        label: 1,
        posX: 500,
        posY: 500,
        hint: "Umesao 1969",
        isCurrent: false,
      },
      { namespaceId: there.namespaceId, label: 2, hint: null },
    ]);
  });

  it("leaves out the warps of the namespace asking", async () => {
    const { db, here } = await setup();
    await addWarp({ db, namespaceId: here.namespaceId, posX: 100, posY: 100 });

    expect(await (await GET(event(db, here.namespaceId))).json()).toEqual([]);
  });

  it("answers 404 for a namespace that does not exist", async () => {
    const { db } = await setup();

    await expect(Promise.resolve(GET(event(db, "missing")))).rejects.toMatchObject({
      status: 404,
      body: { message: "Namespace not found" },
    });
  });
});
