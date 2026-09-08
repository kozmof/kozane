import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { getCardTagHits } from "./tag.js";
import { addNamespace } from "./namespace.js";
import { addPartition } from "./partition.js";
import { addCard } from "./card.js";
import { addLayer } from "./layer.js";

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "P" });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "B" });
  return { db, namespaceId, partitionId };
}

/** A second namespace with a partition of its own, for the cross-namespace cases. */
async function addSecondNamespace(db: Awaited<ReturnType<typeof createTestDB>>) {
  const namespaceId = await addNamespace({ db, name: "Other" });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "B" });
  return { namespaceId, partitionId };
}

const sorted = (tags: string[]) => [...tags].sort();

describe("getCardTagHits", () => {
  it("finds nothing in a namespace with no cards", async () => {
    const { db, namespaceId } = await setup();
    expect(await getCardTagHits({ db, namespaceId })).toEqual({
      hits: [],
      cardData: {},
      cardNamespaces: {},
      truncated: false,
    });
  });

  it("returns a hit naming the card it came from", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "caching work 'perf:cache" });

    const result = await getCardTagHits({ db, namespaceId });
    expect(result).toMatchObject({
      hits: [
        {
          tag: "perf:cache",
          source: { kind: "card", cardId },
          excerpt: "caching work 'perf:cache",
        },
      ],
      cardData: { [cardId]: { namespaceId, partitionId } },
      cardNamespaces: { [cardId]: namespaceId },
      truncated: false,
    });
    expect(result.cardData[cardId]?.updatedDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns every tag on a card", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "'perf and 'perf:cache\nand 'docs" });

    const { hits } = await getCardTagHits({ db, namespaceId });
    expect(sorted(hits.map(({ tag }) => tag))).toEqual(["docs", "perf", "perf:cache"]);
  });

  it("skips a card whose apostrophe is not a tag", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "don't tag this, and 'quoted' stays text" });

    const { hits, cardNamespaces } = await getCardTagHits({ db, namespaceId });
    expect(hits).toEqual([]);
    // Not named either: a card with no tag is not a card this answers about.
    expect(cardNamespaces).toEqual({});
  });

  it("skips a card with no apostrophe at all", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "nothing to see here" });

    expect((await getCardTagHits({ db, namespaceId })).hits).toEqual([]);
  });

  it("gathers across every partition of the namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const otherPartitionId = await addPartition({ db, namespaceId, name: "Other" });
    await addCard({ db, partitionId, content: "'one" });
    await addCard({ db, partitionId: otherPartitionId, content: "'two" });

    const { hits } = await getCardTagHits({ db, namespaceId });
    expect(sorted(hits.map(({ tag }) => tag))).toEqual(["one", "two"]);
  });

  it("does not reach into another namespace when one is named", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const other = await addSecondNamespace(db);
    await addCard({ db, partitionId, content: "'mine" });
    await addCard({ db, partitionId: other.partitionId, content: "'theirs" });

    const { hits } = await getCardTagHits({ db, namespaceId });
    expect(hits.map(({ tag }) => tag)).toEqual(["mine"]);
  });

  it("gathers every namespace when none is named", async () => {
    const { db, partitionId } = await setup();
    const other = await addSecondNamespace(db);
    await addCard({ db, partitionId, content: "'mine" });
    await addCard({ db, partitionId: other.partitionId, content: "'theirs" });

    const { hits } = await getCardTagHits({ db });
    expect(sorted(hits.map(({ tag }) => tag))).toEqual(["mine", "theirs"]);
  });

  it("says which namespace each card belongs to", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const other = await addSecondNamespace(db);
    const mine = await addCard({ db, partitionId, content: "'mine" });
    const theirs = await addCard({ db, partitionId: other.partitionId, content: "'theirs" });

    const { cardNamespaces } = await getCardTagHits({ db });
    expect(cardNamespaces).toEqual({ [mine]: namespaceId, [theirs]: other.namespaceId });
  });

  it("normalizes a tag's case, so one tag written two ways is one tag", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "'Perf" });
    await addCard({ db, partitionId, content: "'perf" });

    const { hits } = await getCardTagHits({ db, namespaceId });
    expect(hits.map(({ tag }) => tag)).toEqual(["perf", "perf"]);
  });

  /**
   * The card side has a ceiling of its own, and had none for a long while: the file walk was
   * bounded three ways over and this was bounded not at all, though both fill the same array,
   * are written to the same cache file, and are sent to the same page.
   */
  describe("the hit ceiling", () => {
    it("stops at the ceiling and says so", async () => {
      const { db, namespaceId, partitionId } = await setup();
      for (let i = 0; i < 4; i++) await addCard({ db, partitionId, content: `'tag${i}` });

      const { hits, truncated } = await getCardTagHits({ db, namespaceId, hitsMax: 2 });

      expect(hits).toHaveLength(2);
      expect(truncated).toBe(true);
    });

    /** Exact rather than per card, the same as the file walk's: one card can hold more tags
     *  on its own than the whole gather carries. */
    it("holds the ceiling exactly, within a single card", async () => {
      const { db, namespaceId, partitionId } = await setup();
      await addCard({ db, partitionId, content: "'one\n'two\n'three" });

      const { hits, truncated } = await getCardTagHits({ db, namespaceId, hitsMax: 2 });

      expect(hits.map(({ tag }) => tag)).toEqual(["one", "two"]);
      expect(truncated).toBe(true);
    });

    it("does not report a ceiling a gather sits under", async () => {
      const { db, namespaceId, partitionId } = await setup();
      await addCard({ db, partitionId, content: "'perf" });

      expect((await getCardTagHits({ db, namespaceId, hitsMax: 2 })).truncated).toBe(false);
    });
  });

  /** The read is paged so that a workspace larger than the hit ceiling is not held in memory
   *  on the way to it. What the pages produce has to be what one statement would have. */
  describe("reading in pages", () => {
    it("gathers across page boundaries", async () => {
      const { db, namespaceId, partitionId } = await setup();
      for (let i = 0; i < 7; i++) await addCard({ db, partitionId, content: `'tag${i}` });

      const { hits, truncated } = await getCardTagHits({ db, namespaceId, rowsPage: 2 });

      expect(sorted(hits.map(({ tag }) => tag))).toEqual([
        "tag0",
        "tag1",
        "tag2",
        "tag3",
        "tag4",
        "tag5",
        "tag6",
      ]);
      expect(truncated).toBe(false);
    });

    /** A page that comes back exactly full is not evidence that it was the last one, and a
     *  gather that stopped there would silently drop everything after it. */
    it("reads on past a page that came back exactly full", async () => {
      const { db, namespaceId, partitionId } = await setup();
      for (let i = 0; i < 4; i++) await addCard({ db, partitionId, content: `'tag${i}` });

      const { hits } = await getCardTagHits({ db, namespaceId, rowsPage: 2 });

      expect(hits).toHaveLength(4);
    });

    /** The prefilter is deliberately generous, so a page may hold rows that yield nothing.
     *  Paging must not read that as the end of the cards. */
    it("reads on past a whole page of cards that hold no tag", async () => {
      const { db, namespaceId, partitionId } = await setup();
      // Written first, so they fill the earlier pages: ids are uuidv7, which the read orders
      // by, and are therefore in creation order.
      for (let i = 0; i < 4; i++) await addCard({ db, partitionId, content: `don't ${i}` });
      await addCard({ db, partitionId, content: "'perf" });

      const { hits } = await getCardTagHits({ db, namespaceId, rowsPage: 2 });

      expect(hits.map(({ tag }) => tag)).toEqual(["perf"]);
    });

    it("stops at the hit ceiling without reading the pages after it", async () => {
      const { db, namespaceId, partitionId } = await setup();
      for (let i = 0; i < 6; i++) await addCard({ db, partitionId, content: `'tag${i}` });

      const { hits, truncated } = await getCardTagHits({
        db,
        namespaceId,
        hitsMax: 3,
        rowsPage: 2,
      });

      expect(hits).toHaveLength(3);
      expect(truncated).toBe(true);
    });
  });
});
