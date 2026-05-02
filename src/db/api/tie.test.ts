import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { addTie, getTiesByCard, getTiesByCards, deleteTie } from "./tie.js";
import { addProject } from "./project.js";
import { addBundle } from "./bundle.js";
import { addCard } from "./card.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  const cardA = await addCard({ db, bundleId, content: "A" });
  const cardB = await addCard({ db, bundleId, content: "B" });
  const cardC = await addCard({ db, bundleId, content: "C" });
  return { db, bundleId, cardA, cardB, cardC };
}

describe("addTie", () => {
  it("returns a non-empty id", async () => {
    const { db, cardA, cardB } = await setup();
    const id = await addTie({ db, fromCardId: cardA, toCardId: cardB });
    expect(id).toBeTruthy();
  });

  it("is idempotent — duplicate returns the existing id", async () => {
    const { db, cardA, cardB } = await setup();
    const id1 = await addTie({ db, fromCardId: cardA, toCardId: cardB });
    const id2 = await addTie({ db, fromCardId: cardA, toCardId: cardB });
    expect(id1).toBe(id2);
  });

  it("treats direction as significant: A→B and B→A are different ties", async () => {
    const { db, cardA, cardB } = await setup();
    const id1 = await addTie({ db, fromCardId: cardA, toCardId: cardB });
    const id2 = await addTie({ db, fromCardId: cardB, toCardId: cardA });
    expect(id1).not.toBe(id2);
  });

  it("stores an optional relType", async () => {
    const { db, cardA, cardB } = await setup();
    await addTie({ db, fromCardId: cardA, toCardId: cardB, relType: "depends-on" });
    const ties = await getTiesByCard({ db, cardId: cardA });
    expect(ties[0].relType).toBe("depends-on");
  });
});

describe("getTiesByCard", () => {
  it("returns ties where the card is the source", async () => {
    const { db, cardA, cardB } = await setup();
    await addTie({ db, fromCardId: cardA, toCardId: cardB });
    const ties = await getTiesByCard({ db, cardId: cardA });
    expect(ties).toHaveLength(1);
    expect(ties[0].fromCardId).toBe(cardA);
  });

  it("returns ties where the card is the target", async () => {
    const { db, cardA, cardB } = await setup();
    await addTie({ db, fromCardId: cardA, toCardId: cardB });
    const ties = await getTiesByCard({ db, cardId: cardB });
    expect(ties).toHaveLength(1);
    expect(ties[0].toCardId).toBe(cardB);
  });

  it("returns empty array when card has no ties", async () => {
    const { db, cardA } = await setup();
    expect(await getTiesByCard({ db, cardId: cardA })).toEqual([]);
  });

  it("returns all ties involving a card (both directions)", async () => {
    const { db, cardA, cardB, cardC } = await setup();
    await addTie({ db, fromCardId: cardA, toCardId: cardB });
    await addTie({ db, fromCardId: cardC, toCardId: cardA });
    const ties = await getTiesByCard({ db, cardId: cardA });
    expect(ties).toHaveLength(2);
  });
});

describe("getTiesByCards", () => {
  it("returns empty array for empty cardIds", async () => {
    const { db } = await setup();
    expect(await getTiesByCards({ db, cardIds: [] })).toEqual([]);
  });

  it("returns all ties involving any of the given cards", async () => {
    const { db, cardA, cardB, cardC } = await setup();
    await addTie({ db, fromCardId: cardA, toCardId: cardB });
    await addTie({ db, fromCardId: cardB, toCardId: cardC });
    const ties = await getTiesByCards({ db, cardIds: [cardA, cardC] });
    expect(ties).toHaveLength(2);
  });
});

describe("deleteTie", () => {
  it("removes the tie so getTiesByCard returns empty", async () => {
    const { db, cardA, cardB } = await setup();
    const tieId = await addTie({ db, fromCardId: cardA, toCardId: cardB });
    await deleteTie({ db, tieId });
    expect(await getTiesByCard({ db, cardId: cardA })).toEqual([]);
  });

  it("throws NotFoundError for a missing tieId", async () => {
    const { db } = await setup();
    await expect(deleteTie({ db, tieId: "ghost" })).rejects.toThrow(NotFoundError);
  });
});
