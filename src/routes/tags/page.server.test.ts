import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject } from "$db/api/project";
import { addBundle } from "$db/api/bundle";
import { addLayer } from "$db/api/layer";
import { addCard, addCards } from "$db/api/card";
import { addTaskspace } from "$db/api/taskspace";
import type { DB } from "$db/tx";
import { createTestDB } from "../../test-utils/db.js";
import { TAG_HITS_SHOWN_MAX } from "$lib/constants";
import { load } from "./+page.server.js";

/**
 * The loader, which is where the live page's narrowing and capping happen — the browser
 * repeats the filter and would agree either way, so a mistake here is one nothing else on
 * the page can catch.
 *
 * There is no workspace root in this process, so `loadTagIndex` answers about cards alone.
 * That is the half this file is about; the file half is `lib/server/tag-index.test.ts`.
 */

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  const { id: layerId } = await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  return { db, projectId, bundleId, layerId };
}

const run = (db: DB, query = "") =>
  load({
    locals: { db },
    url: new URL(`http://localhost/tags${query}`),
  } as never) as Promise<{
    tag: string | null;
    hits: { tag: string }[];
    cardTotal: number | null;
    fileTotal: number | null;
    taskspaces: Record<string, { name: string; projectId: string | null }>;
    tree: { tag: string }[];
    projectId: string | null;
    cardProjects: Record<string, string>;
    bundles: Record<string, { name: string }>;
    cardBundleIds: Record<string, string>;
  }>;

describe("GET /tags", () => {
  it("answers with the tree and no hits until a tag is named", async () => {
    const { db, bundleId } = await setup();
    await addCard({ db, bundleId, content: "'perf work" });

    const data = await run(db);

    expect(data.tag).toBeNull();
    expect(data.hits).toEqual([]);
    expect(data.cardTotal).toBe(0);
    expect(data.tree.map(({ tag }) => tag)).toEqual(["perf"]);
  });

  it("answers with a named tag's hits, and its subcategories", async () => {
    const { db, bundleId } = await setup();
    await addCard({ db, bundleId, content: "'perf" });
    await addCard({ db, bundleId, content: "'perf:cache" });
    await addCard({ db, bundleId, content: "'other" });

    const data = await run(db, "?tag=perf");

    expect(data.hits.map(({ tag }) => tag).sort()).toEqual(["perf", "perf:cache"]);
    expect(data.cardTotal).toBe(2);
  });

  it("reads the tag as the index stores it, whatever case it was asked in", async () => {
    const { db, bundleId } = await setup();
    await addCard({ db, bundleId, content: "'Perf" });

    const data = await run(db, "?tag=PERF");

    expect(data.tag).toBe("perf");
    expect(data.hits).toHaveLength(1);
  });

  // A `?projectId=` naming nothing would otherwise gather nothing and read as a workspace
  // with no tags in it.
  it("refuses a project that is not there rather than answering empty", async () => {
    const { db } = await setup();

    await expect(run(db, "?projectId=nope")).rejects.toMatchObject({ status: 404 });
  });

  it("narrows to the project it was given", async () => {
    const { db, projectId, bundleId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "B" });
    await addCard({ db, bundleId, content: "'perf mine" });
    await addCard({ db, bundleId: otherBundle, content: "'perf theirs" });

    expect((await run(db, "?tag=perf")).hits).toHaveLength(2);

    const narrowed = await run(db, `?tag=perf&projectId=${projectId}`);
    expect(narrowed.projectId).toBe(projectId);
    expect(narrowed.hits.map((hit) => hit)).toHaveLength(1);
  });

  /** The tree above the list counts every hit, so a capped list has to report what it is a
   *  part of — otherwise the two numbers on the page read as a disagreement. */
  it("caps the list it sends and says how many there were", async () => {
    const { db, bundleId, layerId } = await setup();
    const over = TAG_HITS_SHOWN_MAX + 20;
    await addCards({
      db,
      bundleId,
      layerId,
      cards: Array.from({ length: over }, (_, i) => ({
        content: `'perf card ${i}`,
        posX: 0,
        posY: i,
      })),
    });

    const data = await run(db, "?tag=perf");

    expect(data.hits).toHaveLength(TAG_HITS_SHOWN_MAX);
    expect(data.cardTotal).toBe(over);
  });

  /** Which bundle a card is in is deliberately not on a hit, so the page joins it back for
   *  the hits it is actually showing. */
  it("names the bundle of each card it sends", async () => {
    const { db, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "'perf" });

    const data = await run(db, "?tag=perf");

    expect(data.cardBundleIds[cardId]).toBe(bundleId);
    expect(data.bundles[bundleId].name).toBe("B");
  });

  /**
   * The lookup records are keyed by every tagged card in the workspace and the list by at
   * most a couple of hundred, so sending them whole meant sending a map of thousands to
   * label a page of two hundred. An export is the exception and is covered below: it bakes
   * every hit and cannot know which keys the browser will end up needing.
   */
  it("sends the project of the cards it is showing, and not of the others", async () => {
    const { db, bundleId } = await setup();
    const shown = await addCard({ db, bundleId, content: "'perf" });
    const other = await addCard({ db, bundleId, content: "'unrelated" });

    const data = await run(db, "?tag=perf");

    expect(data.cardProjects).toHaveProperty(shown);
    expect(data.cardProjects).not.toHaveProperty(other);
  });

});

/**
 * The export path, which reads `KOZANE_SSG` when the module is first evaluated — so it is
 * reached by re-importing the module under that environment rather than by a parameter.
 */
describe("as a static export", () => {
  /** Workspace roots written to disk by the tests below, removed whichever way one ends. */
  const roots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    (await import("$db/internal/config"))._resetWorkspaceRootForTest();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function loadUnderSsg(db: DB, env: Record<string, string> = {}) {
    vi.stubEnv("KOZANE_SSG", "1");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    // The root is resolved once and cached for the process, so a test that sets one has to
    // drop what an earlier one resolved. Imported from the module graph this call is about
    // to rebuild, hence inside rather than at the top of the file.
    (await import("$db/internal/config"))._resetWorkspaceRootForTest();
    const { load } = await import("./+page.server.js");
    return (await load({ locals: { db }, url: new URL("http://localhost/tags") } as never)) as {
      taskspaces: Record<string, { name: string; projectId: string | null }>;
      hits: unknown[];
    };
  }

  /**
   * A taskspace's name is the name of a directory on someone's machine, and an export is
   * published. `loadProjectSnapshot` holds exactly this line for the board; this page was
   * shipping `getAllTaskspaces` unconditionally, which contradicted it and
   * `docs/security-matrix.md` with it — and shipped nothing usable either, since a plain
   * export carries no file hits for a name to label.
   *
   * It is no longer a rule the page states: the names it publishes are the taskspaces the
   * gather walked, and a plain export walks none. The two tests below are the two halves of
   * that, and both are now about the walk rather than about a separate condition.
   */
  it("names no taskspaces at all", async () => {
    const { db, projectId } = await setup();
    await addTaskspace({ db, projectId, name: "client-work", path: "client-work" });

    expect((await loadUnderSsg(db)).taskspaces).toEqual({});
  });

  it("names them once the export was built to carry files", async () => {
    const root = mkdtempSync(join(tmpdir(), "kozane-tags-ssg-"));
    roots.push(root);
    mkdirSync(join(root, ".kozane"), { recursive: true });
    writeFileSync(join(root, ".kozane", "config.json"), "{}");
    mkdirSync(join(root, "client-work"), { recursive: true });
    writeFileSync(join(root, "client-work", "notes.md"), "'perf in a file\n");

    const { db, projectId } = await setup();
    const taskspaceId = await addTaskspace({
      db,
      projectId,
      name: "client-work",
      path: "client-work",
    });

    const data = await loadUnderSsg(db, {
      KOZANE_SSG_INCLUDE_SCOPED_FILES: "1",
      KOZANE_WORKSPACE_ROOT: root,
    });

    expect(data.taskspaces[taskspaceId]).toEqual({ name: "client-work", projectId });
  });

  /** An export has no query string, so it bakes every hit and the browser selects. */
  it("bakes every card hit rather than waiting to be asked for one tag", async () => {
    const { db, bundleId } = await setup();
    await addCard({ db, bundleId, content: "'perf" });
    await addCard({ db, bundleId, content: "'other" });

    expect((await loadUnderSsg(db)).hits).toHaveLength(2);
  });
});
