import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { cardTable } from "../schema.js";
import type { DB } from "../tx.js";
import { WARP_HINT_MAX_CHARS } from "../../lib/warp-list.js";
import { INSERT_CHUNK_MAX } from "../../lib/constants.js";
import {
  addCard,
  addCards,
  defaultLayerIdForBundle,
  getCard,
  getAllCards,
  getCardsByBundles,
  getCardMarkersByProjects,
  updateProjectCardPositions,
  updateCard,
  getCardBundleNames,
  reassignCardsToBundle,
  reassignCardsToLayer,
  cardsInProject,
} from "./card.js";
import { addProject } from "./project.js";
import { addBundle } from "./bundle.js";
import { NotFoundError } from "./utils.js";
import { addLayer } from "./layer.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Test Project" });
  await addLayer({ db, projectId: projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "General" });
  return { db, projectId, bundleId };
}

describe("addCards", () => {
  it("returns nothing for an empty list, without touching the database", async () => {
    const { db, bundleId } = await setup();
    const layerId = await defaultLayerIdForBundle(db, bundleId);
    expect(await addCards({ db, bundleId, layerId, cards: [] })).toEqual([]);
    expect(await getAllCards({ db, bundleId })).toHaveLength(0);
  });

  it("stores each row's own content and position", async () => {
    const { db, bundleId } = await setup();
    const layerId = await defaultLayerIdForBundle(db, bundleId);
    const ids = await addCards({
      db,
      bundleId,
      layerId,
      cards: [
        { content: "first", posX: 10, posY: 20 },
        { content: "second", posX: 30, posY: 40 },
      ],
    });
    expect(ids).toHaveLength(2);
    const first = await getCard({ db, bundleId, cardId: ids[0] });
    const second = await getCard({ db, bundleId, cardId: ids[1] });
    expect(first).toMatchObject({ content: "first", posX: 10, posY: 20, layerId });
    expect(second).toMatchObject({ content: "second", posX: 30, posY: 40, layerId });
  });

  // The ids come back in the order the rows were given, which is the order the text of a
  // squashed card reads — a caller filing them into a scope pairs them up by position.
  it("returns ids in the order the rows were given, across a chunk boundary", async () => {
    const { db, bundleId } = await setup();
    const layerId = await defaultLayerIdForBundle(db, bundleId);
    const cards = Array.from({ length: INSERT_CHUNK_MAX + 25 }, (_, index) => ({
      content: `card ${index}`,
      posX: index,
      posY: 0,
    }));
    const ids = await addCards({ db, bundleId, layerId, cards });

    expect(ids).toHaveLength(cards.length);
    expect(new Set(ids).size).toBe(cards.length);
    const stored = await getAllCards({ db, bundleId });
    const byId = new Map(stored.map((card) => [card.id, card]));
    expect(ids.map((id) => byId.get(id)?.content)).toEqual(cards.map(({ content }) => content));
  });
});

describe("addCard", () => {
  it("returns a non-empty id", async () => {
    const { db, bundleId } = await setup();
    const id = await addCard({ db, bundleId, content: "Hello" });
    expect(id).toBeTruthy();
  });

  it("defaults position to (0, 0)", async () => {
    const { db, bundleId } = await setup();
    const id = await addCard({ db, bundleId, content: "Hello" });
    const card = await getCard({ db, bundleId, cardId: id });
    expect(card?.posX).toBe(0);
    expect(card?.posY).toBe(0);
  });

  it("stores specified position", async () => {
    const { db, bundleId } = await setup();
    const id = await addCard({ db, bundleId, content: "Hi", posX: 100, posY: 200 });
    const card = await getCard({ db, bundleId, cardId: id });
    expect(card?.posX).toBe(100);
    expect(card?.posY).toBe(200);
  });

  it("assigns unique ids", async () => {
    const { db, bundleId } = await setup();
    const id1 = await addCard({ db, bundleId, content: "A" });
    const id2 = await addCard({ db, bundleId, content: "B" });
    expect(id1).not.toBe(id2);
  });
});

describe("getCard", () => {
  it("returns the card when bundleId and cardId match", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.id).toBe(cardId);
    expect(card?.content).toBe("Hi");
    expect(card?.bundleId).toBe(bundleId);
  });

  it("returns undefined for a missing cardId", async () => {
    const { db, bundleId } = await setup();
    expect(await getCard({ db, bundleId, cardId: "ghost" })).toBeUndefined();
  });

  it("returns undefined when cardId belongs to a different bundle", async () => {
    const { db, projectId, bundleId } = await setup();
    const otherId = await addBundle({ db, projectId, name: "Other" });
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    expect(await getCard({ db, bundleId: otherId, cardId })).toBeUndefined();
  });
});

describe("getAllCards", () => {
  it("returns empty array for a bundle with no cards", async () => {
    const { db, bundleId } = await setup();
    expect(await getAllCards({ db, bundleId })).toEqual([]);
  });

  it("returns all cards in the bundle", async () => {
    const { db, bundleId } = await setup();
    const c1 = await addCard({ db, bundleId, content: "A" });
    const c2 = await addCard({ db, bundleId, content: "B" });
    const cards = await getAllCards({ db, bundleId });
    expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining([c1, c2]));
    expect(cards).toHaveLength(2);
  });
});

describe("getCardsByBundles", () => {
  it("returns empty array for an empty bundleIds list", async () => {
    const { db } = await setup();
    expect(await getCardsByBundles({ db, bundleIds: [] })).toEqual([]);
  });

  it("returns cards across multiple bundles", async () => {
    const { db, projectId, bundleId } = await setup();
    const b2 = await addBundle({ db, projectId, name: "Second" });
    const c1 = await addCard({ db, bundleId, content: "In b1" });
    const c2 = await addCard({ db, bundleId: b2, content: "In b2" });
    const cards = await getCardsByBundles({ db, bundleIds: [bundleId, b2] });
    expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining([c1, c2]));
    expect(cards).toHaveLength(2);
  });

  it("does not return cards from bundles not in the list", async () => {
    const { db, projectId, bundleId } = await setup();
    const b2 = await addBundle({ db, projectId, name: "Second" });
    await addCard({ db, bundleId: b2, content: "Not included" });
    const cards = await getCardsByBundles({ db, bundleIds: [bundleId] });
    expect(cards).toHaveLength(0);
  });
});

describe("getCardMarkersByProjects", () => {
  it("returns empty array for an empty projectIds list", async () => {
    const { db } = await setup();
    expect(await getCardMarkersByProjects({ db, projectIds: [] })).toEqual([]);
  });

  it("returns the position, stacking and content of every card in the named projects", async () => {
    const { db, projectId, bundleId } = await setup();
    const b2 = await addBundle({ db, projectId, name: "Second" });
    await addCard({ db, bundleId, content: "In b1", posX: 24, posY: 48 });
    await addCard({ db, bundleId: b2, content: "In b2", posX: 96, posY: 96, zIndex: 3 });

    const markers = await getCardMarkersByProjects({ db, projectIds: [projectId] });

    // `width` is null for a card that has never been resized, which is most of them: it
    // follows `ui.defaultCardWidth` until someone pins one.
    expect(markers).toEqual(
      expect.arrayContaining([
        {
          projectId,
          posX: 24,
          posY: 48,
          zIndex: 0,
          content: "In b1",
          contentChars: 5,
          width: null,
        },
        {
          projectId,
          posX: 96,
          posY: 96,
          zIndex: 3,
          content: "In b2",
          contentChars: 5,
          width: null,
        },
      ]),
    );
    expect(markers).toHaveLength(2);
  });

  // The reason the column is read at all: a resized card is drawn in a box it set itself,
  // and that is the box `nearestCardHint` measures a warp against.
  it("carries the width of a card that has been resized", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Wide", posX: 24, posY: 48 });
    await updateCard({ db, cardId, bundleId, width: 420 });

    const markers = await getCardMarkersByProjects({ db, projectIds: [projectId] });

    expect(markers).toEqual([
      { projectId, posX: 24, posY: 48, zIndex: 0, content: "Wide", contentChars: 4, width: 420 },
    ]);
  });

  it("does not return cards from a project not in the list", async () => {
    const { db, bundleId } = await setup();
    const otherProjectId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherProjectId, name: "Base", isDefault: true });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "General" });
    await addCard({ db, bundleId, content: "Mine" });
    await addCard({ db, bundleId: otherBundleId, content: "Theirs" });

    const markers = await getCardMarkersByProjects({ db, projectIds: [otherProjectId] });

    expect(markers).toMatchObject([{ projectId: otherProjectId, content: "Theirs" }]);
  });

  it("reads only the opening of a long card", async () => {
    const { db, projectId, bundleId } = await setup();
    // Every card of every project with a warp is read to place one palette row, and a hint
    // is a few dozen characters: the rest of a long card is not worth carrying.
    await addCard({ db, bundleId, content: "A".repeat(4000) });

    const [marker] = await getCardMarkersByProjects({ db, projectIds: [projectId] });

    expect(marker.content.length).toBeGreaterThan(WARP_HINT_MAX_CHARS);
    expect(marker.content.length).toBeLessThan(4000);
    expect(marker.content).toBe("A".repeat(marker.content.length));
  });

  it("says how long the whole card is, however little of it is read", async () => {
    const { db, projectId, bundleId } = await setup();
    // What the opening cannot say: how tall the card is drawn, which is what decides
    // whether a warp is sitting on it.
    await addCard({ db, bundleId, content: "A".repeat(4000) });

    const [marker] = await getCardMarkersByProjects({ db, projectIds: [projectId] });

    expect(marker.contentChars).toBe(4000);
  });

  it("counts characters rather than bytes", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "日本語" });

    const [marker] = await getCardMarkersByProjects({ db, projectIds: [projectId] });

    expect(marker.contentChars).toBe(3);
  });
});

describe("updateCard (content)", () => {
  it("changes the content", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Old" });
    await updateCard({ db, cardId, bundleId, content: "New" });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("New");
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db, bundleId } = await setup();
    await expect(updateCard({ db, cardId: "ghost", bundleId, content: "X" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("updateCard (position)", () => {
  it("changes posX and posY", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await updateCard({ db, cardId, bundleId, posX: 300, posY: 400 });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.posX).toBe(300);
    expect(card?.posY).toBe(400);
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db, bundleId } = await setup();
    await expect(updateCard({ db, cardId: "ghost", bundleId, posX: 0, posY: 0 })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("updateCard (width)", () => {
  it("starts a new card with no width of its own", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    const card = await getCard({ db, bundleId, cardId });
    // Null rather than a number: the card is drawn at `ui.defaultCardWidth` and keeps
    // following it, which is what an untouched card is supposed to do.
    expect(card?.width).toBeNull();
  });

  it("pins a width", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await updateCard({ db, cardId, bundleId, width: 360 });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.width).toBe(360);
  });

  it("clears a width back to null", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await updateCard({ db, cardId, bundleId, width: 360 });
    await updateCard({ db, cardId, bundleId, width: null });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.width).toBeNull();
  });

  it("leaves the width alone when it is not named", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await updateCard({ db, cardId, bundleId, width: 360 });
    await updateCard({ db, cardId, bundleId, content: "There" });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.width).toBe(360);
  });
});

describe("updateCard", () => {
  it("updates only the provided fields", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Original", posX: 10, posY: 20 });
    await updateCard({ db, cardId, bundleId, content: "Updated" });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("Updated");
    expect(card?.posX).toBe(10);
    expect(card?.posY).toBe(20);
  });

  it("throws when no fields are provided", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Same" });
    await expect(updateCard({ db, cardId, bundleId })).rejects.toThrow("no fields to update");
  });

  it("can move card to a different bundle", async () => {
    const { db, projectId, bundleId } = await setup();
    const b2 = await addBundle({ db, projectId, name: "Other" });
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await updateCard({ db, cardId, bundleId, newBundleId: b2 });
    expect(await getCard({ db, bundleId: b2, cardId })).toBeDefined();
    expect(await getCard({ db, bundleId, cardId })).toBeUndefined();
  });

  it("can update position fields with content", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Original", posX: 1, posY: 2 });

    await updateCard({ db, cardId, bundleId, content: "Moved", posX: 30, posY: 40 });

    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("Moved");
    expect(card?.posX).toBe(30);
    expect(card?.posY).toBe(40);
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db, bundleId } = await setup();
    await expect(updateCard({ db, cardId: "ghost", bundleId, content: "X" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("updateProjectCardPositions", () => {
  it("returns true for an empty positions array", async () => {
    const { db, projectId } = await setup();
    await expect(updateProjectCardPositions({ db, projectId, positions: [] })).resolves.toBe(true);
  });

  it("updates positions and returns true when all cards belong to the project", async () => {
    const { db, projectId, bundleId } = await setup();
    const c1 = await addCard({ db, bundleId, content: "A", posX: 0, posY: 0 });
    const c2 = await addCard({ db, bundleId, content: "B", posX: 0, posY: 0 });

    const ok = await updateProjectCardPositions({
      db,
      projectId,
      positions: [
        { cardId: c1, posX: 10, posY: 20 },
        { cardId: c2, posX: 30, posY: 40 },
      ],
    });

    expect(ok).toBe(true);
    expect(await getCard({ db, bundleId, cardId: c1 })).toMatchObject({ posX: 10, posY: 20 });
    expect(await getCard({ db, bundleId, cardId: c2 })).toMatchObject({ posX: 30, posY: 40 });
  });

  it("returns false when a card does not belong to the project", async () => {
    const { db, projectId, bundleId } = await setup();
    const ownCard = await addCard({ db, bundleId, content: "Mine", posX: 0, posY: 0 });
    const otherProjectId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherProjectId, name: "Base", isDefault: true });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });
    const foreignCard = await addCard({ db, bundleId: otherBundleId, content: "Theirs" });

    const ok = await updateProjectCardPositions({
      db,
      projectId,
      positions: [
        { cardId: ownCard, posX: 5, posY: 5 },
        { cardId: foreignCard, posX: 9, posY: 9 },
      ],
    });

    expect(ok).toBe(false);
    expect(await getCard({ db, bundleId, cardId: ownCard })).toMatchObject({ posX: 0, posY: 0 });
  });

  it("applies the last entry when a cardId is repeated", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "A", posX: 0, posY: 0 });

    const ok = await updateProjectCardPositions({
      db,
      projectId,
      positions: [
        { cardId, posX: 10, posY: 20 },
        { cardId, posX: 30, posY: 40 },
      ],
    });

    expect(ok).toBe(true);
    expect(await getCard({ db, bundleId, cardId })).toMatchObject({ posX: 30, posY: 40 });
  });
});

describe("getCardBundleNames", () => {
  it("returns empty array for empty input", async () => {
    const { db } = await setup();
    expect(await getCardBundleNames({ db, cardIds: [] })).toEqual([]);
  });

  it("returns cardId, bundleId, and bundleName for each card", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    const result = await getCardBundleNames({ db, cardIds: [cardId] });
    expect(result).toEqual([{ cardId, bundleId, bundleName: "General" }]);
  });

  it("returns one row per card across different bundles", async () => {
    const { db, projectId, bundleId } = await setup();
    const b2 = await addBundle({ db, projectId, name: "Research" });
    const c1 = await addCard({ db, bundleId, content: "A" });
    const c2 = await addCard({ db, bundleId: b2, content: "B" });
    const result = await getCardBundleNames({ db, cardIds: [c1, c2] });
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.cardId === c1)?.bundleName).toBe("General");
    expect(result.find((r) => r.cardId === c2)?.bundleName).toBe("Research");
  });

  it("only returns rows for the requested card ids", async () => {
    const { db, bundleId } = await setup();
    const c1 = await addCard({ db, bundleId, content: "Included" });
    await addCard({ db, bundleId, content: "Excluded" });
    const result = await getCardBundleNames({ db, cardIds: [c1] });
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe(c1);
  });
});

describe("cardsInProject", () => {
  it("returns empty array for empty cardIds", async () => {
    const { db, projectId } = await setup();
    expect(await cardsInProject(db, projectId, [])).toEqual([]);
  });
});

describe("reassignCardsToBundle", () => {
  it("returns true for an empty cardIds array", async () => {
    const { db, projectId, bundleId } = await setup();
    await expect(reassignCardsToBundle({ db, projectId, cardIds: [], bundleId })).resolves.toBe(
      true,
    );
  });

  it("reassigns cards to the target bundle and returns true", async () => {
    const { db, projectId, bundleId } = await setup();
    const targetBundle = await addBundle({ db, projectId, name: "Target" });
    const c1 = await addCard({ db, bundleId, content: "A" });
    const c2 = await addCard({ db, bundleId, content: "B" });

    const ok = await reassignCardsToBundle({
      db,
      projectId,
      cardIds: [c1, c2],
      bundleId: targetBundle,
    });

    expect(ok).toBe(true);
    expect(await getCard({ db, bundleId: targetBundle, cardId: c1 })).toBeDefined();
    expect(await getCard({ db, bundleId: targetBundle, cardId: c2 })).toBeDefined();
    expect(await getCard({ db, bundleId, cardId: c1 })).toBeUndefined();
  });

  it("returns false when a card does not belong to the project", async () => {
    const { db, projectId } = await setup();
    const targetBundle = await addBundle({ db, projectId, name: "Target" });
    const otherProjectId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherProjectId, name: "Base", isDefault: true });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });
    const foreignCard = await addCard({ db, bundleId: otherBundleId, content: "Theirs" });

    const ok = await reassignCardsToBundle({
      db,
      projectId,
      cardIds: [foreignCard],
      bundleId: targetBundle,
    });

    expect(ok).toBe(false);
  });

  it("returns false when the target bundle does not belong to the project", async () => {
    const { db, projectId, bundleId } = await setup();
    const c1 = await addCard({ db, bundleId, content: "A" });
    const otherProjectId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherProjectId, name: "Base", isDefault: true });
    const foreignBundle = await addBundle({ db, projectId: otherProjectId, name: "Foreign" });

    const ok = await reassignCardsToBundle({
      db,
      projectId,
      cardIds: [c1],
      bundleId: foreignBundle,
    });

    expect(ok).toBe(false);
    expect(await getCard({ db, bundleId, cardId: c1 })).toBeDefined();
  });
});

describe("reassignCardsToLayer", () => {
  it("accepts an empty cardIds array without stacking anything", async () => {
    const { db, projectId } = await setup();
    const { id: layerId } = await addLayer({ db, projectId, name: "Draft" });
    await expect(reassignCardsToLayer({ db, projectId, cardIds: [], layerId })).resolves.toEqual({
      ok: true,
      stacking: [],
    });
  });

  it("moves cards onto the target layer", async () => {
    const { db, projectId, bundleId } = await setup();
    const { id: layerId } = await addLayer({ db, projectId, name: "Draft" });
    const c1 = await addCard({ db, bundleId, content: "A" });
    const c2 = await addCard({ db, bundleId, content: "B" });

    const result = await reassignCardsToLayer({ db, projectId, cardIds: [c1, c2], layerId });
    expect(result.ok).toBe(true);

    expect(await getCard({ db, bundleId, cardId: c1 })).toMatchObject({ layerId });
    expect(await getCard({ db, bundleId, cardId: c2 })).toMatchObject({ layerId });
  });

  it("restacks arriving cards above the target layer's own, keeping their order", async () => {
    const { db, projectId, bundleId } = await setup();
    const { id: layerId } = await addLayer({ db, projectId, name: "Draft" });
    // Already on Draft, and well above where the default layer's cards sit.
    await addCard({ db, bundleId, content: "Resident", layerId, zIndex: 40 });
    const lower = await addCard({ db, bundleId, content: "Lower", zIndex: 3 });
    const higher = await addCard({ db, bundleId, content: "Higher", zIndex: 9 });

    const result = await reassignCardsToLayer({
      db,
      projectId,
      cardIds: [higher, lower],
      layerId,
    });

    expect(result).toEqual({
      ok: true,
      stacking: [
        { cardId: lower, zIndex: 41 },
        { cardId: higher, zIndex: 42 },
      ],
    });
    expect(await getCard({ db, bundleId, cardId: lower })).toMatchObject({ layerId, zIndex: 41 });
    expect(await getCard({ db, bundleId, cardId: higher })).toMatchObject({ layerId, zIndex: 42 });
  });

  it("leaves cards already on the target layer where they are", async () => {
    const { db, projectId, bundleId } = await setup();
    const { id: layerId } = await addLayer({ db, projectId, name: "Draft" });
    const resident = await addCard({ db, bundleId, content: "Resident", layerId, zIndex: 5 });

    await expect(
      reassignCardsToLayer({ db, projectId, cardIds: [resident], layerId }),
    ).resolves.toEqual({ ok: true, stacking: [] });
    expect(await getCard({ db, bundleId, cardId: resident })).toMatchObject({ zIndex: 5 });
  });

  it("refuses when a card does not belong to the project", async () => {
    const { db, projectId } = await setup();
    const { id: layerId } = await addLayer({ db, projectId, name: "Draft" });
    const otherProjectId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherProjectId, name: "Base", isDefault: true });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });
    const foreignCard = await addCard({ db, bundleId: otherBundleId, content: "Theirs" });

    await expect(
      reassignCardsToLayer({ db, projectId, cardIds: [foreignCard], layerId }),
    ).resolves.toEqual({ ok: false });
  });

  it("refuses when the target layer belongs to another project", async () => {
    const { db, projectId, bundleId } = await setup();
    const card = await addCard({ db, bundleId, content: "A" });
    const before = await getCard({ db, bundleId, cardId: card });
    const otherProjectId = await addProject({ db, name: "Other" });
    const { id: foreignLayer } = await addLayer({
      db,
      projectId: otherProjectId,
      name: "Theirs",
      isDefault: true,
    });

    await expect(
      reassignCardsToLayer({ db, projectId, cardIds: [card], layerId: foreignLayer }),
    ).resolves.toEqual({ ok: false });
    expect(await getCard({ db, bundleId, cardId: card })).toMatchObject({
      layerId: before!.layerId,
    });
  });
});

/**
 * The rule `kozane card list --sort` rests on: `updated_at` follows a card's text and
 * nothing else about it. The board sends a position PATCH per drag, so were arranging the
 * board to count as updating, the interval between the two timestamps would measure how
 * recently a card was tidied rather than how long it stood before being rewritten.
 *
 * Backdated rather than slept on: the columns are stored to the second, so a card added
 * and edited inside the same second has the same timestamp either way. Setting a known
 * past value is what makes "did this move" answerable at all.
 */
describe("card timestamps", () => {
  const LONG_AGO = new Date("2020-01-01T00:00:00Z");

  async function backdate(db: DB, cardId: string): Promise<void> {
    await db
      .update(cardTable)
      .set({ createdAt: LONG_AGO, updatedAt: LONG_AGO })
      .where(eq(cardTable.id, cardId));
  }

  it("stamps a new card as created and updated together", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.createdAt).toBeInstanceOf(Date);
    expect(card?.updatedAt.getTime()).toBe(card?.createdAt.getTime());
  });

  it("stamps every card of a batch insert", async () => {
    const { db, bundleId } = await setup();
    const layerId = await defaultLayerIdForBundle(db, bundleId);
    const ids = await addCards({
      db,
      bundleId,
      layerId,
      cards: [
        { content: "first", posX: 0, posY: 0 },
        { content: "second", posX: 0, posY: 0 },
      ],
    });
    for (const cardId of ids) {
      const card = await getCard({ db, bundleId, cardId });
      expect(card?.updatedAt.getTime()).toBe(card?.createdAt.getTime());
    }
  });

  it("moves updatedAt when the content changes, and leaves createdAt where it was", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Old" });
    await backdate(db, cardId);

    await updateCard({ db, cardId, bundleId, content: "New" });

    const card = await getCard({ db, bundleId, cardId });
    expect(card?.createdAt.getTime()).toBe(LONG_AGO.getTime());
    expect(card?.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("leaves updatedAt alone when the content sent is what the card already held", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Unchanged" });
    await backdate(db, cardId);

    // What the board's composer sends when a card is opened and saved without an edit: the
    // field is present, so `updateCard` writes it, and the row is left exactly as it was.
    await updateCard({ db, cardId, bundleId, content: "Unchanged" });

    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("Unchanged");
    expect(card?.updatedAt.getTime()).toBe(LONG_AGO.getTime());
  });

  it("moves updatedAt when a re-save changes the content back to something new", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "First" });
    await backdate(db, cardId);

    await updateCard({ db, cardId, bundleId, content: "First" });
    await updateCard({ db, cardId, bundleId, content: "Second" });

    const card = await getCard({ db, bundleId, cardId });
    expect(card?.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("leaves updatedAt alone for a card that was only moved, resized, or restacked", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await backdate(db, cardId);

    await updateCard({ db, cardId, bundleId, posX: 300, posY: 400 });
    await updateCard({ db, cardId, bundleId, width: 360 });
    await updateCard({ db, cardId, bundleId, zIndex: 7 });

    const card = await getCard({ db, bundleId, cardId });
    expect(card?.posX).toBe(300);
    expect(card?.updatedAt.getTime()).toBe(LONG_AGO.getTime());
  });

  it("leaves updatedAt alone for a card dragged through updateProjectCardPositions", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await backdate(db, cardId);

    await updateProjectCardPositions({
      db,
      projectId,
      positions: [{ cardId, posX: 120, posY: 240 }],
    });

    const card = await getCard({ db, bundleId, cardId });
    expect(card?.posX).toBe(120);
    expect(card?.updatedAt.getTime()).toBe(LONG_AGO.getTime());
  });

  it("leaves updatedAt alone for a card moved to another bundle or layer", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await backdate(db, cardId);
    const otherBundleId = await addBundle({ db, projectId, name: "Other" });
    const { id: otherLayerId } = await addLayer({ db, projectId, name: "Draft" });

    await reassignCardsToLayer({ db, projectId, cardIds: [cardId], layerId: otherLayerId });
    await reassignCardsToBundle({ db, projectId, cardIds: [cardId], bundleId: otherBundleId });

    const card = await getCard({ db, bundleId: otherBundleId, cardId });
    expect(card?.layerId).toBe(otherLayerId);
    expect(card?.updatedAt.getTime()).toBe(LONG_AGO.getTime());
  });
});
