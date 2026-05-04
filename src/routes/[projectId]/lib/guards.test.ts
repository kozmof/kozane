import { describe, it, expect } from "vitest";
import { allCardsBelongToProject, requireCardInProject } from "./guards.js";
import { createTestDB } from "../../../test-utils/db.js";
import { addProject } from "../../../db/api/project.js";
import { addBundle } from "../../../db/api/bundle.js";
import { addCard } from "../../../db/api/card.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Test Project" });
  const bundleId = await addBundle({ db, projectId, name: "General" });
  const cardId = await addCard({ db, bundleId, content: "hello" });
  return { db, projectId, bundleId, cardId };
}

describe("requireCardInProject", () => {
  it("returns card id and bundleId when card belongs to project", async () => {
    const { db, projectId, bundleId, cardId } = await setup();
    const result = await requireCardInProject(db, projectId, cardId);
    expect(result).toEqual({ id: cardId, bundleId });
  });

  it("throws 404 when card exists but belongs to a different project", async () => {
    const { db, cardId } = await setup();
    const otherId = await addProject({ db, name: "Other Project" });
    await expect(requireCardInProject(db, otherId, cardId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws 404 when card does not exist", async () => {
    const { db, projectId } = await setup();
    await expect(requireCardInProject(db, projectId, "no-such-card")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("allCardsBelongToProject", () => {
  it("returns true for an empty card list", async () => {
    const { db, projectId } = await setup();
    expect(await allCardsBelongToProject(db, projectId, [])).toBe(true);
  });

  it("returns true when every card belongs to the project", async () => {
    const { db, projectId, bundleId, cardId } = await setup();
    const secondCardId = await addCard({ db, bundleId, content: "second" });

    expect(await allCardsBelongToProject(db, projectId, [cardId, secondCardId])).toBe(true);
  });

  it("returns false when any card belongs to another project", async () => {
    const { db, projectId, cardId } = await setup();
    const otherProjectId = await addProject({ db, name: "Other" });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });
    const otherCardId = await addCard({ db, bundleId: otherBundleId, content: "elsewhere" });

    expect(await allCardsBelongToProject(db, projectId, [cardId, otherCardId])).toBe(false);
  });

  it("returns false for a missing card", async () => {
    const { db, projectId, cardId } = await setup();
    expect(await allCardsBelongToProject(db, projectId, [cardId, "ghost"])).toBe(false);
  });
});
