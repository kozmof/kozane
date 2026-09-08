import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestDB,
  isTooManyVariables,
  seedCards,
  SQLITE_VARIABLE_MAX,
} from "../../test-utils/db.js";
import type { DB } from "../tx.js";
import { addNamespace } from "./namespace.js";
import { addPartition } from "./partition.js";
import { addCard } from "./card.js";
import { getGlueRelsByCards, getGlueRelsByNamespace, glueCards, unglueCards } from "./glue.js";
import { glueTable } from "../schema.js";
import { INSERT_CHUNK_MAX } from "../../lib/constants.js";
import { addLayer } from "./layer.js";

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "P" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "B" });
  const cardA = await addCard({ db, partitionId, content: "A" });
  const cardB = await addCard({ db, partitionId, content: "B" });
  const cardC = await addCard({ db, partitionId, content: "C" });
  return { db, partitionId, cardA, cardB, cardC };
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
  //
  // The cards are seeded in one statement rather than added one at a time: `addCard` is two
  // round trips per card — the insert and the default-layer lookup — and a fixture of this
  // size built that way ran the test past its 10s timeout on CI while saying nothing about
  // what is being tested, which is only that a group spanning batches ends up in one group.
  const groupSize = INSERT_CHUNK_MAX * 2 + 50;

  it("glues a group spanning several insert batches into one glue group", async () => {
    const db = await createTestDB();
    const { cardIds } = await namespaceWithCards(db, "P", groupSize);

    const glueId = await glueCards({ db, cardIds });

    const rels = await getGlueRelsByCards({ db, cardIds });
    expect(rels).toHaveLength(groupSize);
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

/** A namespace of `cardCount` cards, built through {@link seedCards}. */
async function namespaceWithCards(db: DB, name: string, cardCount: number) {
  const namespaceId = await addNamespace({ db, name });
  const { id: layerId } = await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: `${name}-partition` });
  const cardIds = await seedCards(db, { partitionId, layerId, count: cardCount, prefix: name });
  return { namespaceId, partitionId, cardIds };
}

const byCardId = (rels: { cardId: string }[]) =>
  [...rels].sort((a, b) => a.cardId.localeCompare(b.cardId));

describe("getGlueRelsByNamespace", () => {
  it("returns nothing for a namespace whose cards are all unglued", async () => {
    const db = await createTestDB();
    const { namespaceId } = await namespaceWithCards(db, "P", 3);
    expect(await getGlueRelsByNamespace({ db, namespaceId })).toEqual([]);
  });

  it("agrees with getGlueRelsByCards handed every card of the namespace", async () => {
    const db = await createTestDB();
    const { namespaceId, cardIds } = await namespaceWithCards(db, "P", 4);
    await glueCards({ db, cardIds: [cardIds[0], cardIds[1]] });
    await glueCards({ db, cardIds: [cardIds[2], cardIds[3]] });

    const byNamespace = await getGlueRelsByNamespace({ db, namespaceId });

    expect(byNamespace).toHaveLength(4);
    expect(byCardId(byNamespace)).toEqual(byCardId(await getGlueRelsByCards({ db, cardIds })));
  });

  it("leaves another namespace's glue rows out", async () => {
    const db = await createTestDB();
    const mine = await namespaceWithCards(db, "mine", 2);
    const theirs = await namespaceWithCards(db, "theirs", 2);
    await glueCards({ db, cardIds: mine.cardIds });
    await glueCards({ db, cardIds: theirs.cardIds });

    const rels = await getGlueRelsByNamespace({ db, namespaceId: mine.namespaceId });

    expect(new Set(rels.map((rel) => rel.cardId))).toEqual(new Set(mine.cardIds));
  });

  // Why this function exists at all. `getGlueRelsByCards` binds one parameter per card, and
  // the board handed it every card in the namespace on every page load and every poll — so a
  // namespace this size did not load slowly, it did not load. Selecting by namespace binds one
  // parameter whatever the board holds, which takes the row count out of the question.
  it("reads a namespace holding more cards than one statement could name", async () => {
    const db = await createTestDB();
    const { namespaceId, cardIds } = await namespaceWithCards(db, "big", SQLITE_VARIABLE_MAX + 1);
    await glueCards({ db, cardIds: cardIds.slice(0, 2) });

    await expect(getGlueRelsByCards({ db, cardIds }).catch(isTooManyVariables)).resolves.toBe(true);
    await expect(getGlueRelsByNamespace({ db, namespaceId })).resolves.toHaveLength(2);
  });
});
