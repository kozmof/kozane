import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { addBundle } from "$db/api/bundle.js";
import { addCard } from "$db/api/card.js";
import { addLayer } from "$db/api/layer.js";
import { addProject } from "$db/api/project.js";
import { addScope } from "$db/api/scope.js";
import { addScopeRel } from "$db/api/scope-rel.js";
import { addTaskspace } from "$db/api/taskspace.js";
import { glueCards } from "$db/api/glue.js";
import type { DB } from "$db/tx.js";
import { _resetWorkspaceRootForTest } from "$db/internal/config.js";
import { createTestDB } from "../../../test-utils/db.js";
import { loadProjectSnapshot } from "./project-snapshot.js";
import { readProjectSnapshot } from "./snapshot-reader.js";

/** The card fields a board is sent, which is what `CardData` names and nothing more. */
const CARD_KEYS = [
  "bundleId",
  "content",
  "glueId",
  "id",
  "layerId",
  "posX",
  "posY",
  "taskspaceId",
  "width",
  "zIndex",
];

async function project(db: DB, name = "P") {
  const projectId = await addProject({ db, name });
  const { id: layerId } = await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  return { projectId, bundleId, layerId };
}

const load = (db: DB, projectId: string) =>
  loadProjectSnapshot({
    db,
    projectId,
    includeTaskspacePaths: true,
    includeScopes: true,
    includeScopedFiles: false,
  });

describe("loadProjectSnapshot", () => {
  it("answers null for a project that does not exist", async () => {
    const db = await createTestDB();
    expect(await load(db, "nope")).toBeNull();
  });

  it("carries the cards of the project's bundles, with their glue groups", async () => {
    const db = await createTestDB();
    const { projectId, bundleId } = await project(db);
    const first = await addCard({ db, bundleId, content: "one" });
    const second = await addCard({ db, bundleId, content: "two" });
    await addCard({ db, bundleId, content: "three" });
    const glueId = await glueCards({ db, cardIds: [first, second] });

    const loaded = await load(db, projectId);

    expect(loaded?.snapshot.cards).toHaveLength(3);
    const byId = new Map(loaded?.snapshot.cards.map((card) => [card.id, card]));
    expect(byId.get(first)?.glueId).toBe(glueId);
    expect(byId.get(second)?.glueId).toBe(glueId);
    expect(loaded?.snapshot.glueRels).toHaveLength(2);
  });

  it("carries the scope memberships of this project's cards only", async () => {
    const db = await createTestDB();
    const mine = await project(db, "mine");
    const theirs = await project(db, "theirs");
    const scopeId = await addScope({ db, name: "shared" });
    const cardId = await addCard({ db, bundleId: mine.bundleId, content: "mine" });
    const otherCardId = await addCard({ db, bundleId: theirs.bundleId, content: "theirs" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: otherCardId });

    const loaded = await load(db, mine.projectId);

    expect(loaded?.snapshot.scopeRels).toEqual([{ scopeId, cardId }]);
  });

  /**
   * The board is a published surface: a page load serves this to whatever browser asked for
   * it, and `kozane net ssg generate` bakes it into output whose exact contents
   * `docs/security-matrix.md` enumerates. A card is therefore sent as the fields `CardData`
   * names, not as the row it came from.
   *
   * This is the guard against going back to selecting the row. Drizzle's `select()`
   * enumerates the columns the *schema* declares — it does not emit `SELECT *` — so a column
   * that exists only in the database was never going to arrive here. The one that would is a
   * column added to `cardTable`, and that reached the wire by the act of adding it: nothing
   * in the snapshot path named the card fields, so nothing objected. Verified both ways
   * before this test was written.
   *
   * Asserted as an exact key set rather than "has the fields the board needs", because the
   * absence of anything else is the whole point. The forward guarantee is stronger and lives
   * in `card.ts`: `CARD_DATA_SELECTION` is `satisfies Record<keyof CardData, AnyColumn>`, so
   * the query, the type, and `readCard` cannot drift apart without a compile error.
   */
  it("sends exactly the declared card fields and nothing else", async () => {
    const db = await createTestDB();
    const { projectId, bundleId } = await project(db);
    await addCard({ db, bundleId, content: "one" });

    const loaded = await load(db, projectId);

    expect(Object.keys(loaded!.snapshot.cards[0]).sort()).toEqual(CARD_KEYS);
  });

  it("redacts taskspace paths when the caller asks it to", async () => {
    const db = await createTestDB();
    const { projectId } = await project(db);

    const exported = await loadProjectSnapshot({
      db,
      projectId,
      includeTaskspacePaths: false,
      includeScopes: true,
      includeScopedFiles: false,
    });

    expect(exported?.snapshot.taskspaces.every(({ path }) => path === null)).toBe(true);
  });

  it("omits scopes, scope relations, and taskspaces entirely when the caller asks it to", async () => {
    const db = await createTestDB();
    const { projectId, bundleId } = await project(db);
    const scopeId = await addScope({ db, name: "S" });
    const cardId = await addCard({ db, bundleId, content: "one" });
    await addScopeRel({ db, scopeId, cardId });

    const exported = await loadProjectSnapshot({
      db,
      projectId,
      includeTaskspacePaths: false,
      includeScopes: false,
      includeScopedFiles: false,
    });

    expect(exported?.snapshot.scopes).toEqual([]);
    expect(exported?.snapshot.scopeRels).toEqual([]);
    expect(exported?.snapshot.taskspaces).toEqual([]);
    // Cards themselves are unaffected — leaving scopes out is about organization, not content.
    expect(exported?.snapshot.cards).toHaveLength(1);
  });

  // `includeScopedFiles` is the one flag that reaches out to the real filesystem, so it
  // gets a real taskspace directory to point at rather than a bare database row — the
  // question these tests answer is whether a file on disk ends up in the export, which a
  // taskspace record with no directory behind it cannot exercise either way.
  describe("with a taskspace directory on disk", () => {
    let tmpRoot: string;
    let taskspaceDir: string;
    let prevEnv: string | undefined;

    beforeEach(() => {
      tmpRoot = join(tmpdir(), `kozane-snapshot-test-${randomUUID()}`);
      taskspaceDir = join(tmpRoot, "demo");
      mkdirSync(join(tmpRoot, ".kozane"), { recursive: true });
      writeFileSync(join(tmpRoot, ".kozane", "config.json"), JSON.stringify({ name: "test" }));
      mkdirSync(taskspaceDir, { recursive: true });
      writeFileSync(join(taskspaceDir, "README.md"), "hello\n");

      prevEnv = process.env.KOZANE_WORKSPACE_ROOT;
      process.env.KOZANE_WORKSPACE_ROOT = tmpRoot;
      _resetWorkspaceRootForTest();
    });

    afterEach(() => {
      if (prevEnv === undefined) delete process.env.KOZANE_WORKSPACE_ROOT;
      else process.env.KOZANE_WORKSPACE_ROOT = prevEnv;
      _resetWorkspaceRootForTest();
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    /**
     * The core guarantee behind `--include-scoped-files` being opt-in: a taskspace with a
     * real, readable directory must not leak a byte of it into the export unless the
     * caller asked for file contents specifically, even when scopes and taskspace names
     * themselves are included. Scope visibility and file contents are two different
     * questions, and only the second one touches the filesystem.
     */
    it("never reads taskspace files from disk when includeScopedFiles is false", async () => {
      const db = await createTestDB();
      const { projectId } = await project(db);
      await addTaskspace({ db, projectId, name: "demo", path: "demo" });

      const exported = await loadProjectSnapshot({
        db,
        projectId,
        includeTaskspacePaths: false,
        includeScopes: true,
        includeScopedFiles: false,
      });

      expect(exported?.snapshot.taskspaces).toHaveLength(1);
      expect(exported?.snapshot.taskspaceFiles).toBeUndefined();
      expect(JSON.stringify(exported?.snapshot)).not.toContain("hello");
    });

    it("embeds a taskspace's files, content inline, when includeScopedFiles is true", async () => {
      const db = await createTestDB();
      const { projectId } = await project(db);
      const scopeId = await addScope({ db, name: "work" });
      const taskspaceId = await addTaskspace({
        db,
        scopeId,
        projectId,
        name: "demo",
        path: "demo",
      });

      const exported = await loadProjectSnapshot({
        db,
        projectId,
        includeTaskspacePaths: false,
        includeScopes: true,
        includeScopedFiles: true,
      });

      expect(exported?.snapshot.taskspaceFiles?.[taskspaceId]).toEqual({
        root: {
          kind: "directory",
          name: "",
          truncated: null,
          children: [{ kind: "file", name: "README.md", content: "hello\n", size: 6 }],
        },
      });
    });

    /**
     * The panel lists a taskspace under a scope and nowhere else, so a taskspace with no
     * scope — what `kozane taskspace create` makes by default — is unreachable in the
     * exported UI. Carrying it anyway would publish a local directory's name, and its whole
     * contents, for a taskspace the site never so much as mentions, readable straight out of
     * the page data by anyone who looks: the same reason scopes themselves are filtered
     * server-side rather than hidden client-side.
     */
    it("leaves a taskspace that belongs to no scope, and so is never drawn, out of the export entirely", async () => {
      const db = await createTestDB();
      const { projectId } = await project(db);
      const scopeId = await addScope({ db, name: "work" });
      const drawn = await addTaskspace({ db, scopeId, projectId, name: "drawn", path: "demo" });
      await addTaskspace({ db, projectId, name: "unscoped", path: "demo" }); // no `scopeId`

      const exported = await loadProjectSnapshot({
        db,
        projectId,
        includeTaskspacePaths: false,
        includeScopes: true,
        includeScopedFiles: true,
      });

      expect(exported?.snapshot.taskspaces.map(({ id }) => id)).toEqual([drawn]);
      expect(Object.keys(exported!.snapshot.taskspaceFiles!)).toEqual([drawn]);
      expect(JSON.stringify(exported?.snapshot)).not.toContain("unscoped");
    });

    /**
     * The board is not an export: it is behind the workspace API key, showing the user the
     * workspace they are working in, which is why it is sent real paths in the first place.
     * Filtering it to what the panel happens to draw today would be a different decision
     * from the one above, and not this one's to make.
     */
    it("still names every taskspace to the live board, scope or no scope", async () => {
      const db = await createTestDB();
      const { projectId } = await project(db);
      await addTaskspace({ db, projectId, name: "unscoped", path: "demo" });

      const loaded = await load(db, projectId);

      expect(loaded?.snapshot.taskspaces.map(({ name }) => name)).toEqual(["unscoped"]);
    });

    it("builds no file tree for a taskspace that has no directory, even when asked to", async () => {
      const db = await createTestDB();
      const { projectId } = await project(db);
      await addTaskspace({ db, projectId, name: "no-dir" }); // no `path`

      const exported = await loadProjectSnapshot({
        db,
        projectId,
        includeTaskspacePaths: false,
        includeScopes: true,
        includeScopedFiles: true,
      });

      expect(exported?.snapshot.taskspaceFiles).toEqual({});
    });

    // The documented invariant on `includeScopedFiles` — "implies includeScopes" — held as
    // code, not only as a comment: a caller that asks for file contents without also asking
    // for the taskspaces themselves gets neither, rather than an orphaned `taskspaceFiles`
    // map keyed by ids the rest of the snapshot never named.
    it("builds no file tree at all when includeScopes is false, regardless of includeScopedFiles", async () => {
      const db = await createTestDB();
      const { projectId } = await project(db);
      await addTaskspace({ db, projectId, name: "demo", path: "demo" });

      const exported = await loadProjectSnapshot({
        db,
        projectId,
        includeTaskspacePaths: false,
        includeScopes: false,
        includeScopedFiles: true,
      });

      expect(exported?.snapshot.taskspaces).toEqual([]);
      expect(exported?.snapshot.taskspaceFiles).toBeUndefined();
    });
  });

  // The pair this function exists to keep identical: what the page load hands the board, and
  // what the poll hands it a second later. A snapshot the reader cannot read is one the poll
  // would drop on the floor, leaving the board on whatever it had.
  it("produces a snapshot the poll's reader accepts unchanged", async () => {
    const db = await createTestDB();
    const { projectId, bundleId } = await project(db);
    const scopeId = await addScope({ db, name: "S" });
    const cardId = await addCard({ db, bundleId, content: "one" });
    const second = await addCard({ db, bundleId, content: "two" });
    await addScopeRel({ db, scopeId, cardId });
    await glueCards({ db, cardIds: [cardId, second] });

    const loaded = await load(db, projectId);
    // Through JSON, because that is the only form the poll ever sees one in.
    const read = readProjectSnapshot(JSON.parse(JSON.stringify(loaded!.snapshot)));

    expect(read).toEqual(loaded!.snapshot);
  });
});
