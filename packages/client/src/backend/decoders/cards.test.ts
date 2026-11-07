import { expect, it } from "vitest";
import { baseCard, cardResults } from "../../../../kozane/src/test-utils/card-results.js";
import {
  readCardCreated,
  readCardUpdated,
  readCardStacked,
  readCardSquashed,
  readGlueCreated,
  readGlueRemoved,
} from "./cards.js";
const create = { partitionId: "p", content: "Text" };
it("preserves canvas and stored creation fields, including repaired neighbours", () => {
  expect(readCardCreated(cardResults["cards.create"], create)).toEqual(cardResults["cards.create"]);
  const stored = {
    ...baseCard,
    inventory: { id: "i", slot: 0 },
    placements: [
      { cardId: "c", inventoryId: "i", slot: 0 },
      { cardId: "neighbour", inventoryId: "i", slot: 6 },
    ],
  };
  expect(readCardCreated(stored, { ...create, inventoryId: "i", layerId: "l" })).toEqual(stored);
  for (const value of [
    { ...stored, placements: [] },
    { ...stored, inventory: { id: "i", slot: -1 } },
    { ...stored, placements: [{ cardId: "c", inventoryId: "other", slot: 0 }] },
    { ...cardResults["cards.create"], width: 200 },
    { ...cardResults["cards.create"], partitionId: "other" },
  ])
    expect(readCardCreated(value, create)).toBeNull();
  expect(readCardCreated(cardResults["cards.create"], { ...create, layerId: "other" })).toBeNull();
  expect(readCardCreated(cardResults["cards.create"], { ...create, inventoryId: "i" })).toBeNull();
});
it("requires stacking, normalized edited text and internally consistent refit fields", () => {
  const update = {
    ok: true,
    stacking: [],
    content: "Edited",
    inventory: { id: "i", slot: 6 },
    placements: [{ cardId: "c", inventoryId: "i", slot: 6 }],
  };
  expect(readCardUpdated(update, "c", { content: " Edited " })).toEqual(update);
  expect(readCardUpdated({ ok: true, stacking: [] }, "c", { width: null })).toEqual({
    ok: true,
    stacking: [],
  });
  expect(readCardUpdated({ ok: true, stacking: [] }, "c", { content: "Text" })).toBeNull();
  for (const value of [
    { ok: true },
    { ...update, inventory: null },
    { ...update, inventory: { id: "i", slot: -1 } },
    { ...update, placements: [] },
    { ...update, placements: null },
    { ...update, content: 1 },
    { ...update, stacking: [{ cardId: "c", zIndex: Infinity }] },
    {
      ...update,
      stacking: [
        { cardId: "c", zIndex: 1 },
        { cardId: "c", zIndex: 2 },
      ],
    },
  ])
    expect(readCardUpdated(value, "c", {})).toBeNull();
  expect(readCardStacked({ ok: true, stacking: [] })).toEqual({ ok: true, stacking: [] });
});
it("validates complete squash pieces and their destination without accepting partial arrays", () => {
  const squash = cardResults["cards.squash"];
  expect(readCardSquashed(squash, "n /")).toEqual(squash);
  expect(readCardSquashed(squash, "other")).toBeNull();
  for (const cards of [
    [],
    [squash.cards[0]],
    [squash.cards[0], {}],
    [squash.cards[0], squash.cards[0]],
    [squash.cards[0], { ...squash.cards[1], inventory: { id: "other", slot: 1 } }],
    [squash.cards[0], { ...squash.cards[1], inventory: { id: "i", slot: 0 } }],
    [squash.cards[0], { ...squash.cards[1], glueId: "g" }],
  ])
    expect(readCardSquashed({ ...squash, cards }, "n /")).toBeNull();
});
it("retains no-op glue results but rejects missing or duplicate cleared IDs", () => {
  expect(readGlueCreated(cardResults["glues.create"])).toEqual(cardResults["glues.create"]);
  expect(readGlueRemoved(cardResults["glues.remove"])).toEqual(cardResults["glues.remove"]);
  expect(readGlueCreated({ glueId: "g" })).toBeNull();
  expect(readGlueCreated({ glueId: "g", clearedCardIds: ["c", "c"] })).toBeNull();
  expect(readGlueRemoved({ ok: false, clearedCardIds: [] })).toBeNull();
});
it("normalizes squash wire timestamps to the declared Date results and rejects invalid dates", () => {
  const squash = cardResults["cards.squash"];
  const wire = JSON.parse(JSON.stringify(squash));
  const decoded = readCardSquashed(wire, "n /");
  expect(decoded).toEqual(squash);
  expect(decoded!.cards[0].createdAt).toBeInstanceOf(Date);
  for (const createdAt of [null, "bad-date", "2026-11-05", new Date(NaN)]) {
    expect(
      readCardSquashed(
        { ...squash, cards: [{ ...squash.cards[0], createdAt }, squash.cards[1]] },
        "n /",
      ),
    ).toBeNull();
  }
});
it("accepts actual service results through card editing, inventory refit, glue and squash", async () => {
  const { createTestDB } = await import("../../../../kozane/src/test-utils/db.js");
  const { createServiceContext } = await import("../../../../kozane/src/services/context.js");
  const namespaces = await import("../../../../kozane/src/services/namespaces.js");
  const cards = await import("../../../../kozane/src/services/cards.js");
  const glues = await import("../../../../kozane/src/services/glues.js");
  const layers = await import("../../../../kozane/src/services/layers.js");
  const inventories = await import("../../../../kozane/src/services/inventories.js");
  const { get } = await import("../../../../kozane/src/services/snapshot.js");
  const db = await createTestDB();
  const context = createServiceContext();
  const namespace = await namespaces.create(db, context, { name: "Board" });
  const partitionId = (await get(db, context, namespace.id))!.snapshot.partitions[0].id;
  const createInput = { content: " First sentence. Second sentence. ", partitionId };
  const card = await cards.create(db, context, namespace.id, createInput);
  expect(readCardCreated(card, createInput)).toEqual(card);
  const second = await cards.create(db, context, namespace.id, { content: "Other", partitionId });
  const glued = await glues.create(db, context, namespace.id, { cardIds: [card.id, second.id] });
  expect(readGlueCreated(glued)).toEqual(glued);
  const unglued = await glues.remove(db, context, namespace.id, { cardIds: [card.id] });
  expect(readGlueRemoved(unglued)).toEqual(unglued);
  const noOp = await glues.remove(db, context, namespace.id, { cardIds: [card.id] });
  expect(readGlueRemoved(noOp)).toEqual(noOp);
  expect(noOp.clearedCardIds).toContain(card.id);
  const layer = await layers.create(db, context, namespace.id, { name: "Notes" });
  const stacked = await cards.setLayer(db, context, namespace.id, {
    cardIds: [card.id],
    layerId: layer.id,
  });
  expect(readCardStacked(stacked)).toEqual(stacked);
  const front = await cards.setStacking(db, context, namespace.id, {
    cardIds: [card.id],
    direction: "front",
  });
  expect(readCardStacked(front)).toEqual(front);
  const bag = await inventories.create(db, context, namespace.id, { posX: 0, posY: 0 });
  const storedInput = { content: "Stored", partitionId, inventoryId: bag.id };
  const stored = await cards.create(db, context, namespace.id, storedInput);
  expect(readCardCreated(stored, storedInput)).toEqual(stored);
  await inventories.stow(db, context, namespace.id, bag.id, { cardIds: [second.id], slot: 6 });
  const normalized = Array.from({ length: 12 }, () => "Normalized edit").join("\n");
  const edit = { content: ` ${normalized} ` };
  const edited = await cards.update(db, context, namespace.id, stored.id, edit);
  expect(readCardUpdated(edited, stored.id, edit)).toEqual(edited);
  expect(edited.content).toBe(normalized);
  expect(edited.placements?.length).toBeGreaterThan(0);
  const squash = await cards.squash(db, context, namespace.id, { cardId: card.id });
  expect(readCardSquashed(squash, namespace.id)).toEqual(squash);
  expect(readCardSquashed(JSON.parse(JSON.stringify(squash)), namespace.id)).toEqual(squash);
  const after = (await get(db, context, namespace.id))!.snapshot;
  expect(after.cards.some((row) => row.id === card.id)).toBe(false);
  expect(squash.cards).toHaveLength(2);
  expect(
    squash.cards.every((row) => row.inventory?.id === squash.inventory.id && row.glueId === null),
  ).toBe(true);
});
