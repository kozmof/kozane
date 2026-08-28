import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createTestDB } from "../../test-utils/db.js";
import { addProject } from "../../db/api/project.js";
import { addBundle } from "../../db/api/bundle.js";
import { addLayer } from "../../db/api/layer.js";
import { addCard } from "../../db/api/card.js";
import { addTaskspace } from "../../db/api/taskspace.js";
import { clearTaskspaceTagCache } from "./taskspace-tags.js";
import { loadTagIndex } from "./tag-index.js";

/** The tags found, sorted, so a test says what was gathered rather than in what order. */
const tags = (hits: { tag: string }[]) => hits.map(({ tag }) => tag).sort();

describe("loadTagIndex", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `kozane-tag-index-test-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    clearTaskspaceTagCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function setup() {
    const db = await createTestDB();
    const projectId = await addProject({ db, name: "P" });
    await addLayer({ db, projectId, name: "Base", isDefault: true });
    const bundleId = await addBundle({ db, projectId, name: "B" });
    return { db, projectId, bundleId };
  }

  /** A taskspace directory under the workspace root, with one file in it. `projectId` is
   *  optional because a row belonging to no project is a case this has to cover. */
  async function seedTaskspace(
    db: Awaited<ReturnType<typeof createTestDB>>,
    projectId: string | undefined,
    name: string,
    content: string,
  ) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "notes.md"), content);
    return addTaskspace({ db, projectId, name, path: name });
  }

  it("gathers card tags and file tags into one list", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "on a card 'perf" });
    await seedTaskspace(db, projectId, "notes", "in a file 'docs\n");

    const { hits } = await loadTagIndex({ db, projectId, includeFiles: true, root });

    expect(tags(hits)).toEqual(["docs", "perf"]);
    expect(hits.map(({ source }) => source.kind).sort()).toEqual(["card", "file"]);
  });

  it("leaves files out when it is told to", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "on a card 'perf" });
    await seedTaskspace(db, projectId, "notes", "in a file 'docs\n");

    const { hits } = await loadTagIndex({ db, projectId, includeFiles: false, root });

    expect(tags(hits)).toEqual(["perf"]);
  });

  it("answers about cards alone when there is no workspace root to resolve against", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "'perf" });

    const { hits } = await loadTagIndex({
      db,
      projectId,
      includeFiles: true,
      root: null,
    });

    expect(tags(hits)).toEqual(["perf"]);
  });

  it("reads a taskspace belonging to no project, which every board draws", async () => {
    const { db, projectId } = await setup();
    await seedTaskspace(db, undefined, "loose", "'unplaced\n");

    const { hits } = await loadTagIndex({ db, projectId, includeFiles: true, root });

    expect(tags(hits)).toEqual(["unplaced"]);
  });

  it("does not read another project's taskspace", async () => {
    const { db, projectId } = await setup();
    const otherProjectId = await addProject({ db, name: "Other" });
    await seedTaskspace(db, otherProjectId, "theirs", "'theirs\n");

    const { hits } = await loadTagIndex({ db, projectId, includeFiles: true, root });

    expect(hits).toEqual([]);
  });

  it("skips a taskspace row with no path", async () => {
    const { db, projectId } = await setup();
    await addTaskspace({ db, projectId, name: "pathless" });

    const { hits, truncated } = await loadTagIndex({
      db,
      projectId,
      includeFiles: true,
      root,
    });

    expect(hits).toEqual([]);
    expect(truncated).toEqual([]);
  });

  it("names the taskspace it could not read in full", async () => {
    const { db, projectId } = await setup();
    const taskspaceId = await seedTaskspace(db, projectId, "notes", "'foo\n");
    rmSync(join(root, "notes"), { recursive: true, force: true });

    const { truncated } = await loadTagIndex({
      db,
      projectId,
      includeFiles: true,
      root,
    });

    expect(truncated).toEqual([{ taskspaceId, reasons: ["unreadable"] }]);
  });

  describe("across the workspace", () => {
    /** A second project with a card and a taskspace of its own. */
    async function addSecondProject(db: Awaited<ReturnType<typeof createTestDB>>) {
      const projectId = await addProject({ db, name: "Other" });
      await addLayer({ db, projectId, name: "Base", isDefault: true });
      const bundleId = await addBundle({ db, projectId, name: "B" });
      await addCard({ db, bundleId, content: "'theirs" });
      await seedTaskspace(db, projectId, "theirs-notes", "'theirs:file\n");
      return { projectId, bundleId };
    }

    it("gathers cards and files from every project when none is named", async () => {
      const { db, projectId, bundleId } = await setup();
      await addCard({ db, bundleId, content: "'mine" });
      await seedTaskspace(db, projectId, "mine-notes", "'mine:file\n");
      await addSecondProject(db);

      const { hits } = await loadTagIndex({ db, includeFiles: true, root });

      expect(tags(hits)).toEqual(["mine", "mine:file", "theirs", "theirs:file"]);
    });

    it("says which project each card and taskspace belongs to", async () => {
      const { db, projectId, bundleId } = await setup();
      const cardId = await addCard({ db, bundleId, content: "'mine" });
      const taskspaceId = await seedTaskspace(db, projectId, "mine-notes", "'mine:file\n");

      const { cardProjects, taskspaceProjects } = await loadTagIndex({
        db,
        includeFiles: true,
        root,
      });

      expect(cardProjects[cardId]).toBe(projectId);
      expect(taskspaceProjects[taskspaceId]).toBe(projectId);
    });

    it("reports a taskspace belonging to no project as belonging to none", async () => {
      const { db } = await setup();
      const taskspaceId = await seedTaskspace(db, undefined, "loose", "'unplaced\n");

      const { taskspaceProjects } = await loadTagIndex({ db, includeFiles: true, root });

      expect(taskspaceProjects[taskspaceId]).toBeNull();
    });

    it("names a taskspace it looked at even when it held no tags", async () => {
      const { db, projectId } = await setup();
      const taskspaceId = await seedTaskspace(db, projectId, "empty", "nothing here\n");

      const { taskspaceProjects } = await loadTagIndex({ db, includeFiles: true, root });

      expect(taskspaceProjects).toHaveProperty(taskspaceId);
    });
  });
});
