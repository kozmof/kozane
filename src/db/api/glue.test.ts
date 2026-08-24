import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { addProject } from "./project.js";
import { addBundle } from "./bundle.js";
import { addCard } from "./card.js";
import { getGlueRelsByCards, glueCards, unglueCards } from "./glue.js";
import { glueTable } from "../schema.js";
import { addLayer } from "./layer.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  await addLayer({ db, projectId: projectId, name: "Base", isDefault: true });
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

  it("throws when cardIds contains duplicates", async () => {
    const { db, cardA } = await setup();
    await expect(glueCards({ db, cardIds: [cardA, cardA] })).rejects.toThrow(
      "glueCards: cardIds must be unique",
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
    expect(await unglueCards({ db, cardIds: [] })).toEqual([]);
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

  it("removes the group row when every member is unglued at once", async () => {
    const { db, cardA, cardB } = await setup();
    const glueId = await glueCards({ db, cardIds: [cardA, cardB] });

    await unglueCards({ db, cardIds: [cardA, cardB] });

    // A group emptied in one call produces no GROUP BY row, so this is the case a
    // `HAVING count() <= 1` filter silently skips, leaking the `glue` row.
    expect(await getGlueRelsByCards({ db, cardIds: [cardA, cardB] })).toEqual([]);
    expect(await db.select().from(glueTable).where(eq(glueTable.id, glueId))).toEqual([]);
  });

  it("dissolves groups left with one member", async () => {
    const { db, cardA, cardB } = await setup();
    const glueId = await glueCards({ db, cardIds: [cardA, cardB] });

    await unglueCards({ db, cardIds: [cardA] });

    expect(await getGlueRelsByCards({ db, cardIds: [cardA, cardB] })).toEqual([]);
    expect(await db.select().from(glueTable).where(eq(glueTable.id, glueId))).toEqual([]);
  });
});

describe("glueCards over the insert batch size", () => {
  // `INSERT_CHUNK_MAX` is 200 rows, so a group larger than that is the case a single
  // statement used to cover and `chunked` now splits. Every other bulk insert here was
  // already chunked; this one was the outlier.
  it("glues a group spanning several insert batches into one glue group", async () => {
    const db = await createTestDB();
    const projectId = await addProject({ db, name: "P" });
    await addLayer({ db, projectId, name: "Base", isDefault: true });
    const bundleId = await addBundle({ db, projectId, name: "B" });

    const cardIds: string[] = [];
    for (let i = 0; i < 450; i += 1) {
      cardIds.push(await addCard({ db, bundleId, content: `card ${i}` }));
    }

    const glueId = await glueCards({ db, cardIds });

    const rels = await getGlueRelsByCards({ db, cardIds });
    expect(rels).toHaveLength(450);
    // One group, not one per batch.
    expect(new Set(rels.map((rel) => rel.glueId))).toEqual(new Set([glueId]));
    expect(new Set(rels.map((rel) => rel.cardId))).toEqual(new Set(cardIds));

    // And it comes apart again in one piece.
    const cleared = await unglueCards({ db, cardIds });
    expect(new Set(cleared)).toEqual(new Set(cardIds));
    expect(await getGlueRelsByCards({ db, cardIds })).toEqual([]);
    expect(await db.select().from(glueTable).where(eq(glueTable.id, glueId))).toEqual([]);
  });
});
