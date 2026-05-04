import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addCard,
  getCard,
  getAllCards,
  getCardsByBundles,
  deleteCard,
  updateCardContent,
  updateCardPosition,
  updateCard,
} from "./card.js";
import { addProject } from "./project.js";
import { addBundle } from "./bundle.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Test Project" });
  const bundleId = await addBundle({ db, projectId, name: "General" });
  return { db, projectId, bundleId };
}

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

describe("deleteCard", () => {
  it("removes the card", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Bye" });
    await deleteCard({ db, bundleId, cardId });
    expect(await getCard({ db, bundleId, cardId })).toBeUndefined();
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db, bundleId } = await setup();
    await expect(deleteCard({ db, bundleId, cardId: "ghost" })).rejects.toThrow(NotFoundError);
  });
});

describe("updateCardContent", () => {
  it("changes the content", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Old" });
    await updateCardContent({ db, bundleId, cardId, content: "New" });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("New");
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db, bundleId } = await setup();
    await expect(
      updateCardContent({ db, bundleId, cardId: "ghost", content: "X" }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("updateCardPosition", () => {
  it("changes posX and posY", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await updateCardPosition({ db, cardId, posX: 300, posY: 400 });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.posX).toBe(300);
    expect(card?.posY).toBe(400);
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db } = await setup();
    await expect(updateCardPosition({ db, cardId: "ghost", posX: 0, posY: 0 })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("updateCard", () => {
  it("updates only the provided fields", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Original", posX: 10, posY: 20 });
    await updateCard({ db, cardId, content: "Updated" });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("Updated");
    expect(card?.posX).toBe(10);
    expect(card?.posY).toBe(20);
  });

  it("is a no-op when no fields are provided", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Same" });
    await expect(updateCard({ db, cardId })).resolves.toBeUndefined();
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("Same");
  });

  it("can move card to a different bundle", async () => {
    const { db, projectId, bundleId } = await setup();
    const b2 = await addBundle({ db, projectId, name: "Other" });
    const cardId = await addCard({ db, bundleId, content: "Hi" });
    await updateCard({ db, cardId, bundleId: b2 });
    expect(await getCard({ db, bundleId: b2, cardId })).toBeDefined();
    expect(await getCard({ db, bundleId, cardId })).toBeUndefined();
  });

  it("can update position fields with content", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Original", posX: 1, posY: 2 });

    await updateCard({ db, cardId, content: "Moved", posX: 30, posY: 40 });

    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("Moved");
    expect(card?.posX).toBe(30);
    expect(card?.posY).toBe(40);
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db } = await setup();
    await expect(updateCard({ db, cardId: "ghost", content: "X" })).rejects.toThrow(NotFoundError);
  });
});
