import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTestDB } from "../../test-utils/db.js";
import { addNamespace } from "../../db/api/namespace.js";
import { addLayer } from "../../db/api/layer.js";
import { addPartition } from "../../db/api/partition.js";
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
  const namespaceId = await addNamespace({ db, name: "P" });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "B" });
  return { db, namespaceId, partitionId };
}

const cached = (db: Awaited<ReturnType<typeof createTestDB>>, includeScopes = true) =>
  loadTreemapSnapshot({
    db,
    includeScopes,
    cache: { root, dbUrl: `file:${dbPath}` },
  });

describe("treemap snapshot cache", () => {
  it("stores activity, partition counts, scope graph, and tag dimensions together", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "work 'perf" });
    const scopeId = await addScope({ db, name: "Release" });
    await addScopeRel({ db, scopeId, cardId });

    const snapshot = await cached(db);

    expect(snapshot.namespaces).toContainEqual(expect.objectContaining({ id: namespaceId }));
    expect(snapshot.partitions).toContainEqual(
      expect.objectContaining({ id: partitionId, cards: 1, bg: expect.any(String) }),
    );
    expect(snapshot.activity).toContainEqual(expect.objectContaining({ partitionId, cards: 1 }));
    expect(snapshot.partitionUsage).toEqual([{ scopeId, partitionId, cards: 1 }]);
    expect(snapshot.tags.cardData[cardId]).toMatchObject({ namespaceId, partitionId });
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
    const { db, partitionId } = await setup();
    expect((await cached(db)).partitions.find(({ id }) => id === partitionId)?.cards).toBe(0);

    const cardId = await addCard({ db, partitionId, content: "new 'docs" });
    const rebuilt = await cached(db);

    expect(rebuilt.partitions.find(({ id }) => id === partitionId)?.cards).toBe(1);
    expect(rebuilt.activity).toContainEqual(expect.objectContaining({ partitionId, cards: 1 }));
    expect(rebuilt.tags.cardData[cardId]?.partitionId).toBe(partitionId);
  });

  it("ignores malformed cache files and gathers a valid replacement", async () => {
    const { db } = await setup();
    writeFileSync(treemapCachePath(root), '{"version":1,"snapshot":{}}');

    await expect(cached(db)).resolves.toMatchObject({ namespaces: expect.any(Array) });
    expect(readTreemapCache(root)).not.toBeNull();
  });
});
