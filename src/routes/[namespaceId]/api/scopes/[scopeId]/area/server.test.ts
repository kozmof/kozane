import { describe, expect, it } from "vitest";
import { addScope } from "$db/api/scope.js";
import { getScopeAreasInNamespace, setScopeArea } from "$db/api/scope-area.js";
import { addNamespace } from "$db/api/namespace.js";
import { addLayer } from "$db/api/layer.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../../test-utils/db.js";
import { PUT, DELETE } from "./+server.js";

function event(db: DB, namespaceId: string, scopeId: string, body?: unknown) {
  return {
    locals: { db },
    params: { namespaceId, scopeId },
    request: new Request("http://localhost/", {
      method: body === undefined ? "DELETE" : "PUT",
      ...(body !== undefined && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    }),
  } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const scopeId = await addScope({ db, name: "My Scope" });
  return { db, namespaceId, scopeId };
}

const RECT = { posX: 100, posY: 200, width: 640, height: 480 };

describe("PUT /[namespaceId]/api/scopes/[scopeId]/area", () => {
  it("stores the frame and answers with the whole row", async () => {
    const { db, namespaceId, scopeId } = await setup();

    const response = await PUT(event(db, namespaceId, scopeId, RECT));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: expect.any(String),
      namespaceId,
      scopeId,
      ...RECT,
    });
  });

  it("moves the frame already there rather than adding a second", async () => {
    const { db, namespaceId, scopeId } = await setup();
    await PUT(event(db, namespaceId, scopeId, RECT));

    await PUT(event(db, namespaceId, scopeId, { ...RECT, posX: 900 }));

    const areas = await getScopeAreasInNamespace({ db, namespaceId });
    expect(areas).toHaveLength(1);
    expect(areas[0].posX).toBe(900);
  });

  it("holds a frame dropped past the edge on the board", async () => {
    const { db, namespaceId, scopeId } = await setup();

    // The whole rectangle is held, not only its corner: a frame half off the board is one
    // whose far half can never be reached, and every card it would hold with it.
    const response = await PUT(
      event(db, namespaceId, scopeId, { posX: 99_999, posY: 99_999, width: 640, height: 480 }),
    );

    const stored = await response.json();
    expect(stored.posX + stored.width).toBeLessThanOrEqual(5600);
    expect(stored.posY + stored.height).toBeLessThanOrEqual(4000);
  });

  it("grows a frame smaller than the minimum up to it", async () => {
    const { db, namespaceId, scopeId } = await setup();

    const response = await PUT(
      event(db, namespaceId, scopeId, { posX: 0, posY: 0, width: 1, height: 1 }),
    );

    const stored = await response.json();
    expect(stored.width).toBe(120);
    expect(stored.height).toBe(120);
  });

  it("rounds a fractional rectangle, because the columns are integers", async () => {
    const { db, namespaceId, scopeId } = await setup();

    const response = await PUT(
      event(db, namespaceId, scopeId, { posX: 10.6, posY: 20.4, width: 640.5, height: 480.2 }),
    );

    expect(await response.json()).toMatchObject({ posX: 11, posY: 20, width: 641, height: 480 });
  });

  it("refuses a body missing part of the rectangle", async () => {
    const { db, namespaceId, scopeId } = await setup();

    await expectHttpRejection(
      PUT(event(db, namespaceId, scopeId, { posX: 0, posY: 0, width: 640 })),
      400,
      "posX, posY, width and height are required",
    );
  });

  it("answers 404 for a scope that does not exist", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      PUT(event(db, namespaceId, "no-such-scope", RECT)),
      404,
      "Scope not found",
    );
  });
});

describe("DELETE /[namespaceId]/api/scopes/[scopeId]/area", () => {
  it("removes the frame", async () => {
    const { db, namespaceId, scopeId } = await setup();
    await setScopeArea({ db, namespaceId, scopeId, ...RECT });

    const response = await DELETE(event(db, namespaceId, scopeId));

    expect(await response.json()).toEqual({ ok: true });
    expect(await getScopeAreasInNamespace({ db, namespaceId })).toEqual([]);
  });

  it("answers 404 when there is no frame to remove", async () => {
    const { db, namespaceId, scopeId } = await setup();

    await expectHttpRejection(DELETE(event(db, namespaceId, scopeId)), 404, "Scope area not found");
  });
});
