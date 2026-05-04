import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { addProject } from "./project.js";
import { addBundle } from "./bundle.js";
import { addCard } from "./card.js";
import { getGlueRelsByCards, glueCards, unglueCards } from "./glue.js";
import { glueTable } from "../schema.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  const cardA = await addCard({ db, bundleId, content: "A" });
  const cardB = await addCard({ db, bundleId, content: "B" });
  const cardC = await addCard({ db, bundleId, content: "C" });
  return { db, bundleId, cardA, cardB, cardC };
}

describe("getGlueRelsByCards", () => {
  it("returns empty array for empty cardIds", async () => {
    const { db } = await setup();
    expect(await getGlueRelsByCards({ db, cardIds: [] })).toEqual([]);
  });

  it("returns glue rel rows for the requested cards", async () => {
    const { db, cardA, cardB } = await setup();
    const glueId = await glueCards({ db, cardIds: [cardA, cardB] });

    const rels = await getGlueRelsByCards({ db, cardIds: [cardA] });

    expect(rels).toEqual([{ glueId, cardId: cardA }]);
  });
});

describe("glueCards", () => {
  it("requires at least two cards", async () => {
    const { db, cardA } = await setup();
    await expect(glueCards({ db, cardIds: [cardA] })).rejects.toThrow(
      "glueCards requires at least 2 cards",
    );
  });

  it("creates one glue group containing all provided cards", async () => {
    const { db, cardA, cardB } = await setup();
    const glueId = await glueCards({ db, cardIds: [cardA, cardB] });

    const rels = await getGlueRelsByCards({ db, cardIds: [cardA, cardB] });

    expect(rels).toHaveLength(2);
    expect(rels.map((rel) => rel.cardId)).toEqual(expect.arrayContaining([cardA, cardB]));
    expect(rels.every((rel) => rel.glueId === glueId)).toBe(true);
  });

  it("moves cards out of previous groups and dissolves orphaned groups", async () => {
    const { db, cardA, cardB, cardC } = await setup();
    const oldGlueId = await glueCards({ db, cardIds: [cardA, cardB] });

    const newGlueId = await glueCards({ db, cardIds: [cardB, cardC] });

    expect(newGlueId).not.toBe(oldGlueId);
    expect(await getGlueRelsByCards({ db, cardIds: [cardA] })).toEqual([]);
    const rels = await getGlueRelsByCards({ db, cardIds: [cardB, cardC] });
    expect(rels.every((rel) => rel.glueId === newGlueId)).toBe(true);
    expect(await db.select().from(glueTable).where(eq(glueTable.id, oldGlueId))).toEqual([]);
  });
});

describe("unglueCards", () => {
  it("is a no-op for an empty card list", async () => {
    const { db } = await setup();
    await expect(unglueCards({ db, cardIds: [] })).resolves.toBeUndefined();
  });

  it("removes selected cards and keeps groups with multiple remaining members", async () => {
    const { db, cardA, cardB, cardC } = await setup();
    const glueId = await glueCards({ db, cardIds: [cardA, cardB, cardC] });

    await unglueCards({ db, cardIds: [cardA] });

    expect(await getGlueRelsByCards({ db, cardIds: [cardA] })).toEqual([]);
    const remaining = await getGlueRelsByCards({ db, cardIds: [cardB, cardC] });
    expect(remaining).toHaveLength(2);
    expect(remaining.every((rel) => rel.glueId === glueId)).toBe(true);
  });

  it("dissolves groups left with one member", async () => {
    const { db, cardA, cardB } = await setup();
    const glueId = await glueCards({ db, cardIds: [cardA, cardB] });

    await unglueCards({ db, cardIds: [cardA] });

    expect(await getGlueRelsByCards({ db, cardIds: [cardA, cardB] })).toEqual([]);
    expect(await db.select().from(glueTable).where(eq(glueTable.id, glueId))).toEqual([]);
  });
});
