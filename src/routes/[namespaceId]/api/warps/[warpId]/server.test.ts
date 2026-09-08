import { describe, expect, it } from "vitest";
import { addWarp, getAllWarps } from "$db/api/warp.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE } from "./+server.js";

function event(db: DB, namespaceId: string, warpId: string) {
  return { locals: { db }, params: { namespaceId, warpId } } as never;
}

async function expectHttpRejection(value: unknown, status: number) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  return { db, namespaceId };
}

describe("DELETE /[namespaceId]/api/warps/[warpId]", () => {
  it("removes the warp", async () => {
    const { db, namespaceId } = await setup();
    const warp = await addWarp({ db, namespaceId, posX: 0, posY: 0 });

    const response = await DELETE(event(db, namespaceId, warp.id));

    expect(await response.json()).toEqual({ ok: true });
    expect(await getAllWarps({ db, namespaceId })).toEqual([]);
  });

  it("answers 404 for a warp that does not exist", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(DELETE(event(db, namespaceId, "missing")), 404);
  });

  it("answers 404 for a warp belonging to another namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    const warp = await addWarp({ db, namespaceId, posX: 0, posY: 0 });

    await expectHttpRejection(DELETE(event(db, otherId, warp.id)), 404);
    expect(await getAllWarps({ db, namespaceId })).toMatchObject([{ id: warp.id }]);
  });
});
