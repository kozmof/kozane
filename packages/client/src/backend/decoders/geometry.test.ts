import { expect, it } from "vitest";
import { SCOPE_AREA_MIN_SIZE } from "../../constants/index.js";
import { geometryResults } from "../../../../../src/test-utils/geometry-results.js";
import { readScopeRenamed, readScopeAreaResult, readWarpResult } from "./geometry.js";
import { readCreatedId, readMutationOk } from "./structure.js";

it("decodes complete results and rejects malformed or mismatched geometry", () => {
  const area = geometryResults["scopes.createArea"];
  const warp = geometryResults["warps.create"];
  expect(readScopeRenamed(geometryResults["scopes.rename"], "s")).toEqual({
    id: "s",
    name: "Scope",
  });
  expect(readScopeRenamed({ id: "other", name: "Scope" }, "s")).toBeNull();
  expect(readScopeRenamed({ id: "s", name: 1 }, "s")).toBeNull();
  expect(readScopeAreaResult(area, "n /", "s")).toEqual(area);
  expect(readScopeAreaResult(area, "n /", "s", "a")).toEqual(area);
  expect(readScopeAreaResult(area, "other", "s")).toBeNull();
  expect(readScopeAreaResult(area, "n /", "other")).toBeNull();
  expect(readScopeAreaResult(area, "n /", "s", "other")).toBeNull();
  expect(readScopeAreaResult({ ...area, width: Infinity }, "n /", "s")).toBeNull();
  expect(readScopeAreaResult({}, "n /", "s")).toBeNull();
  expect(readWarpResult(warp, "n /")).toEqual(warp);
  expect(readWarpResult(warp, "n /", "w")).toEqual(warp);
  expect(readWarpResult(warp, "other")).toBeNull();
  expect(readWarpResult(warp, "n /", "other")).toBeNull();
  expect(readWarpResult({ ...warp, posY: NaN }, "n /")).toBeNull();
  expect(readWarpResult(null, "n /")).toBeNull();
});
it("accepts service results with clamped geometry and complete scope membership lifecycle", async () => {
  const { createTestDB } = await import("../../../../../src/test-utils/db.js");
  const { createServiceContext } = await import("../../../../../src/services/context.js");
  const namespaces = await import("../../../../../src/services/namespaces.js");
  const scopes = await import("../../../../../src/services/scopes.js");
  const warps = await import("../../../../../src/services/warps.js");
  const cards = await import("../../../../../src/services/cards.js");
  const { get } = await import("../../../../../src/services/snapshot.js");
  const db = await createTestDB();
  const context = createServiceContext({ canvasWidth: 400, canvasHeight: 400 });
  const namespace = await namespaces.create(db, context, { name: "Board" });
  const scope = await scopes.create(db, context, { name: "Scope" });
  expect(readCreatedId(scope)).toEqual(scope);
  const renamed = await scopes.rename(db, context, namespace.id, scope.id, { name: " Renamed " });
  expect(readScopeRenamed(renamed, scope.id)).toEqual({ id: scope.id, name: "Renamed" });
  const partition = (await get(db, context, namespace.id))!.snapshot.partitions.find(
    (row) => row.isDefault,
  )!;
  const card = await cards.create(db, context, namespace.id, {
    content: "Card",
    partitionId: partition!.id,
  });
  expect(
    readMutationOk(
      await scopes.addMembers(db, context, namespace.id, scope.id, { cardIds: [card.id] }),
    ),
  ).toEqual({ ok: true });
  const area = await scopes.createArea(db, context, namespace.id, scope.id, {
    posX: -50,
    posY: 1000,
    width: 100,
    height: 1000,
  });
  expect(readScopeAreaResult(area, namespace.id, scope.id)).toEqual(area);
  expect(area).toMatchObject({ posX: 0, posY: 0, height: 400 });
  const updated = await scopes.updateArea(db, context, namespace.id, scope.id, area.id, {
    posX: 999,
    posY: -100,
    width: 999,
    height: 100,
  });
  expect(readScopeAreaResult(updated, namespace.id, scope.id, area.id)).toEqual(updated);
  expect(updated).toMatchObject({ posX: 0, posY: 0, width: 400, height: SCOPE_AREA_MIN_SIZE });
  expect((await get(db, context, namespace.id))!.snapshot.scopeRels).toContainEqual({
    scopeId: scope.id,
    cardId: card.id,
  });
  expect(
    readMutationOk(
      await scopes.removeMembers(db, context, namespace.id, scope.id, { cardIds: [card.id] }),
    ),
  ).toEqual({ ok: true });
  expect(
    readMutationOk(await scopes.removeArea(db, context, namespace.id, scope.id, area.id)),
  ).toEqual({ ok: true });
  expect(readMutationOk(await scopes.remove(db, context, namespace.id, scope.id))).toEqual({
    ok: true,
  });
  const warp = await warps.create(db, context, namespace.id, { posX: -4, posY: 999 });
  expect(readWarpResult(warp, namespace.id)).toEqual(warp);
  expect(warp).toMatchObject({ posX: 0, posY: 400 });
  const moved = await warps.update(db, context, namespace.id, warp.id, { posX: 300.6, posY: 4.4 });
  expect(readWarpResult(moved, namespace.id, warp.id)).toEqual(moved);
  expect(moved).toMatchObject({ posX: 301, posY: 4 });
  expect(readMutationOk(await warps.remove(db, context, namespace.id, warp.id))).toEqual({
    ok: true,
  });
  const after = (await get(db, context, namespace.id))!.snapshot;
  expect(after.warps).toEqual([]);
  expect(after.scopeAreas).toEqual([]);
  expect(after.scopeRels).toEqual([]);
  expect(after.scopes).toEqual([]);
});
