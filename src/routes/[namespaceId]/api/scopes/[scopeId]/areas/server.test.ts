import { describe, expect, it } from "vitest";
import { addScope } from "$db/api/scope.js";
import { getScopeAreasInNamespace, addScopeArea } from "$db/api/scope-area.js";
import { addNamespace } from "$db/api/namespace.js";
import { addLayer } from "$db/api/layer.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../../test-utils/db.js";
import { POST } from "./+server.js";
import { PATCH, DELETE } from "./[areaId]/+server.js";

function event(db: DB, namespaceId: string, scopeId: string, areaId: string, body?: unknown) {
  return {
    locals: { db },
    params: { namespaceId, scopeId, areaId },
    request: new Request("http://localhost/", {
      method: body === undefined ? "DELETE" : "POST",
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

describe("POST /[namespaceId]/api/scopes/[scopeId]/areas", () => {
  it("stores the frame and answers with the whole row", async () => {
    const { db, namespaceId, scopeId } = await setup();

    const response = await POST(event(db, namespaceId, scopeId, "", RECT));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: expect.any(String),
      namespaceId,
      scopeId,
      ...RECT,
    });
  });

  it("adds a second frame for a scope rather than moving the first", async () => {
    const { db, namespaceId, scopeId } = await setup();
    await POST(event(db, namespaceId, scopeId, "", RECT));

    await POST(event(db, namespaceId, scopeId, "", { ...RECT, posX: 900 }));

    // A scope organised in two places on one board is framed in two places.
    expect(await getScopeAreasInNamespace({ db, namespaceId })).toHaveLength(2);
  });

  it("holds a frame drawn past the edge on the board", async () => {
    const { db, namespaceId, scopeId } = await setup();

    const response = await POST(
      event(db, namespaceId, scopeId, "", {
        posX: 99_999,
        posY: 99_999,
        width: 640,
        height: 480,
      }),
    );

    // The whole rectangle is held, not only its corner: a frame half off the board is one
    // whose far half can never be reached, and every card it would hold with it.
    const stored = await response.json();
    expect(stored.posX + stored.width).toBeLessThanOrEqual(5600);
    expect(stored.posY + stored.height).toBeLessThanOrEqual(4000);
  });

  it("grows a frame smaller than the minimum up to it", async () => {
    const { db, namespaceId, scopeId } = await setup();

    const response = await POST(
      event(db, namespaceId, scopeId, "", { posX: 0, posY: 0, width: 1, height: 1 }),
    );

    expect(await response.json()).toMatchObject({ width: 120, height: 120 });
  });

  it("refuses a body missing part of the rectangle", async () => {
    const { db, namespaceId, scopeId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, scopeId, "", { posX: 0, posY: 0, width: 640 })),
      400,
      "posX, posY, width and height are required",
    );
  });

  it("answers 404 for a scope that does not exist", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, "no-such-scope", "", RECT)),
      404,
      "Scope not found",
    );
  });
});

describe("PATCH /[namespaceId]/api/scopes/[scopeId]/areas/[areaId]", () => {
  it("moves the frame it names and leaves the scope's others alone", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const first = await addScopeArea({ db, namespaceId, scopeId, ...RECT });
    const second = await addScopeArea({ db, namespaceId, scopeId, ...RECT, posX: 900 });

    await PATCH(event(db, namespaceId, scopeId, first.id, { ...RECT, posX: 1500 }));

    const areas = await getScopeAreasInNamespace({ db, namespaceId });
    expect(areas.find((a) => a.id === first.id)?.posX).toBe(1500);
    expect(areas.find((a) => a.id === second.id)?.posX).toBe(900);
  });

  it("rounds a fractional rectangle, because the columns are integers", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const area = await addScopeArea({ db, namespaceId, scopeId, ...RECT });

    const response = await PATCH(
      event(db, namespaceId, scopeId, area.id, {
        posX: 10.6,
        posY: 20.4,
        width: 640.5,
        height: 480.2,
      }),
    );

    expect(await response.json()).toMatchObject({ posX: 11, posY: 20, width: 641, height: 480 });
  });

  it("answers 404 for a frame this board does not have", async () => {
    const { db, namespaceId, scopeId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, scopeId, "ghost", RECT)),
      404,
      "Scope area not found",
    );
  });
});

describe("DELETE /[namespaceId]/api/scopes/[scopeId]/areas/[areaId]", () => {
  it("removes the frame it names", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const first = await addScopeArea({ db, namespaceId, scopeId, ...RECT });
    const second = await addScopeArea({ db, namespaceId, scopeId, ...RECT, posX: 900 });

    const response = await DELETE(event(db, namespaceId, scopeId, first.id));

    expect(await response.json()).toEqual({ ok: true });
    const areas = await getScopeAreasInNamespace({ db, namespaceId });
    expect(areas.map((a) => a.id)).toEqual([second.id]);
  });

  it("answers 404 when there is no such frame", async () => {
    const { db, namespaceId, scopeId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, namespaceId, scopeId, "ghost")),
      404,
      "Scope area not found",
    );
  });
});
