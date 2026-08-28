import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { getCardTagHits } from "./tag.js";
import { addProject } from "./project.js";
import { addBundle } from "./bundle.js";
import { addCard } from "./card.js";
import { addLayer } from "./layer.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  return { db, projectId, bundleId };
}

/** A second project with a bundle of its own, for the cross-project cases. */
async function addSecondProject(db: Awaited<ReturnType<typeof createTestDB>>) {
  const projectId = await addProject({ db, name: "Other" });
  await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  return { projectId, bundleId };
}

const sorted = (tags: string[]) => [...tags].sort();

describe("getCardTagHits", () => {
  it("finds nothing in a project with no cards", async () => {
    const { db, projectId } = await setup();
    expect(await getCardTagHits({ db, projectId })).toEqual({ hits: [], cardProjects: {} });
  });

  it("returns a hit naming the card it came from", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "caching work 'perf:cache" });

    expect(await getCardTagHits({ db, projectId })).toEqual({
      hits: [
        {
          tag: "perf:cache",
          source: { kind: "card", cardId },
          excerpt: "caching work 'perf:cache",
        },
      ],
      cardProjects: { [cardId]: projectId },
    });
  });

  it("returns every tag on a card", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "'perf and 'perf:cache\nand 'docs" });

    const { hits } = await getCardTagHits({ db, projectId });
    expect(sorted(hits.map(({ tag }) => tag))).toEqual(["docs", "perf", "perf:cache"]);
  });

  it("skips a card whose apostrophe is not a tag", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "don't tag this, and 'quoted' stays text" });

    const { hits, cardProjects } = await getCardTagHits({ db, projectId });
    expect(hits).toEqual([]);
    // Not named either: a card with no tag is not a card this answers about.
    expect(cardProjects).toEqual({});
  });

  it("skips a card with no apostrophe at all", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "nothing to see here" });

    expect((await getCardTagHits({ db, projectId })).hits).toEqual([]);
  });

  it("gathers across every bundle of the project", async () => {
    const { db, projectId, bundleId } = await setup();
    const otherBundleId = await addBundle({ db, projectId, name: "Other" });
    await addCard({ db, bundleId, content: "'one" });
    await addCard({ db, bundleId: otherBundleId, content: "'two" });

    const { hits } = await getCardTagHits({ db, projectId });
    expect(sorted(hits.map(({ tag }) => tag))).toEqual(["one", "two"]);
  });

  it("does not reach into another project when one is named", async () => {
    const { db, projectId, bundleId } = await setup();
    const other = await addSecondProject(db);
    await addCard({ db, bundleId, content: "'mine" });
    await addCard({ db, bundleId: other.bundleId, content: "'theirs" });

    const { hits } = await getCardTagHits({ db, projectId });
    expect(hits.map(({ tag }) => tag)).toEqual(["mine"]);
  });

  it("gathers every project when none is named", async () => {
    const { db, bundleId } = await setup();
    const other = await addSecondProject(db);
    await addCard({ db, bundleId, content: "'mine" });
    await addCard({ db, bundleId: other.bundleId, content: "'theirs" });

    const { hits } = await getCardTagHits({ db });
    expect(sorted(hits.map(({ tag }) => tag))).toEqual(["mine", "theirs"]);
  });

  it("says which project each card belongs to", async () => {
    const { db, projectId, bundleId } = await setup();
    const other = await addSecondProject(db);
    const mine = await addCard({ db, bundleId, content: "'mine" });
    const theirs = await addCard({ db, bundleId: other.bundleId, content: "'theirs" });

    const { cardProjects } = await getCardTagHits({ db });
    expect(cardProjects).toEqual({ [mine]: projectId, [theirs]: other.projectId });
  });

  it("normalizes a tag's case, so one tag written two ways is one tag", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "'Perf" });
    await addCard({ db, bundleId, content: "'perf" });

    const { hits } = await getCardTagHits({ db, projectId });
    expect(hits.map(({ tag }) => tag)).toEqual(["perf", "perf"]);
  });
});
