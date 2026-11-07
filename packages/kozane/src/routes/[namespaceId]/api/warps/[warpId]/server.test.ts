import { describe, expect, it } from "vitest";
import { addWarp, getAllWarps } from "$db/api/warp.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { CANVAS_W, CANVAS_H } from "../../../../../lib/constants.js";
import { DELETE, PATCH } from "./+server.js";

function event(db: DB, namespaceId: string, warpId: string) {
  return { locals: { db }, params: { namespaceId, warpId } } as never;
}

function patchEvent(db: DB, namespaceId: string, warpId: string, body: unknown) {
  const request = new Request(`http://localhost/${namespaceId}/api/warps/${warpId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { locals: { db }, params: { namespaceId, warpId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  return { db, namespaceId };
}

describe("PATCH /[namespaceId]/api/warps/[warpId]", () => {
  it("moves the warp and returns the whole stored row", async () => {
    const { db, namespaceId } = await setup();
    const warp = await addWarp({ db, namespaceId, posX: 10, posY: 20 });

    const response = await PATCH(patchEvent(db, namespaceId, warp.id, { posX: 300, posY: 400 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: warp.id, namespaceId, posX: 300, posY: 400 });
    expect(await getAllWarps({ db, namespaceId })).toMatchObject([{ posX: 300, posY: 400 }]);
  });

  it("clamps a position outside the canvas and rounds it to a whole pixel", async () => {
    const { db, namespaceId } = await setup();
    const warp = await addWarp({ db, namespaceId, posX: 0, posY: 0 });

    const clamped = await PATCH(
      patchEvent(db, namespaceId, warp.id, { posX: CANVAS_W + 1000, posY: CANVAS_H + 1000 }),
    );
    expect(await clamped.json()).toMatchObject({ posX: CANVAS_W, posY: CANVAS_H });

    const rounded = await PATCH(patchEvent(db, namespaceId, warp.id, { posX: -40.6, posY: 10.6 }));
    expect(await rounded.json()).toMatchObject({ posX: 0, posY: 11 });
  });

  it("rejects a request without a position", async () => {
    const { db, namespaceId } = await setup();
    const warp = await addWarp({ db, namespaceId, posX: 10, posY: 20 });

    await expectHttpRejection(PATCH(patchEvent(db, namespaceId, warp.id, { posX: 5 })), 400);
    expect(await getAllWarps({ db, namespaceId })).toMatchObject([{ posX: 10, posY: 20 }]);
  });

  it("answers 404 for a warp that does not exist", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      PATCH(patchEvent(db, namespaceId, "missing", { posX: 1, posY: 2 })),
      404,
    );
  });

  it("answers 404 for a warp belonging to another namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    const warp = await addWarp({ db, namespaceId, posX: 10, posY: 20 });

    await expectHttpRejection(
      PATCH(patchEvent(db, otherId, warp.id, { posX: 300, posY: 400 })),
      404,
    );
    expect(await getAllWarps({ db, namespaceId })).toMatchObject([{ posX: 10, posY: 20 }]);
  });
});

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
