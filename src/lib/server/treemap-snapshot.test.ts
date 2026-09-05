import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTestDB } from "../../test-utils/db.js";
import { addProject } from "../../db/api/project.js";
import { addLayer } from "../../db/api/layer.js";
import { addBundle } from "../../db/api/bundle.js";
import { addCard } from "../../db/api/card.js";
import { addScope } from "../../db/api/scope.js";
import { addScopeRel } from "../../db/api/scope-rel.js";
import { loadTreemapSnapshot, readTreemapCache, treemapCachePath } from "./treemap-snapshot.js";

let root: string;
let dbPath: string;

beforeEach(() => {
  root = join(tmpdir(), `kozane-treemap-cache-${randomUUID()}`);
  dbPath = join(root, "workspace.db");
  mkdirSync(join(root, ".kozane"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function setup() {
  const db = await createTestDB(dbPath);
  const projectId = await addProject({ db, name: "P" });
  await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  return { db, projectId, bundleId };
}

const cached = (db: Awaited<ReturnType<typeof createTestDB>>, includeScopes = true) =>
  loadTreemapSnapshot({
    db,
    includeScopes,
    cache: { root, dbUrl: `file:${dbPath}` },
  });

describe("treemap snapshot cache", () => {
  it("stores activity, bundle counts, scope graph, and tag dimensions together", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "work 'perf" });
    const scopeId = await addScope({ db, name: "Release" });
    await addScopeRel({ db, scopeId, cardId });

    const snapshot = await cached(db);

    expect(snapshot.projects).toContainEqual(expect.objectContaining({ id: projectId }));
    expect(snapshot.bundles).toContainEqual(
      expect.objectContaining({ id: bundleId, cards: 1, bg: expect.any(String) }),
    );
    expect(snapshot.activity).toContainEqual(expect.objectContaining({ bundleId, cards: 1 }));
    expect(snapshot.bundleUsage).toEqual([{ scopeId, bundleId, cards: 1 }]);
    expect(snapshot.tags.cardData[cardId]).toMatchObject({ projectId, bundleId });
    expect(snapshot.tags.hits.map(({ tag }) => tag)).toEqual(["perf"]);
    expect(readTreemapCache(root)?.snapshot).toEqual(snapshot);
  });

  it("reuses a snapshot while the database signature is unchanged", async () => {
    const { db } = await setup();
    await cached(db);
    const builtAt = readTreemapCache(root)?.builtAt;

    await cached(db);

    expect(readTreemapCache(root)?.builtAt).toBe(builtAt);
  });

  it("rebuilds every dimension after the database changes", async () => {
    const { db, bundleId } = await setup();
    expect((await cached(db)).bundles.find(({ id }) => id === bundleId)?.cards).toBe(0);

    const cardId = await addCard({ db, bundleId, content: "new 'docs" });
    const rebuilt = await cached(db);

    expect(rebuilt.bundles.find(({ id }) => id === bundleId)?.cards).toBe(1);
    expect(rebuilt.activity).toContainEqual(expect.objectContaining({ bundleId, cards: 1 }));
    expect(rebuilt.tags.cardData[cardId]?.bundleId).toBe(bundleId);
  });

  it("ignores malformed cache files and gathers a valid replacement", async () => {
    const { db } = await setup();
    writeFileSync(treemapCachePath(root), '{"version":1,"snapshot":{}}');

    await expect(cached(db)).resolves.toMatchObject({ projects: expect.any(Array) });
    expect(readTreemapCache(root)).not.toBeNull();
  });
});
