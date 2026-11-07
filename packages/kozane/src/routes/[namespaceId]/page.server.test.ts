import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StaticBackend,
  type StaticBackendData,
} from "../../../../client/src/backend/static-backend.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  (await import("$db/internal/config.js"))._resetWorkspaceRootForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each([false, true])(
  "seeds the board static backend after scoped-file privacy gates (files %s)",
  async (includeFiles) => {
    const root = mkdtempSync(join(tmpdir(), "kozane-static-board-"));
    roots.push(root);
    mkdirSync(join(root, ".kozane"));
    writeFileSync(join(root, ".kozane", "config.json"), "{}");
    for (const dir of ["scoped", "unlinked"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "notes.md"), dir + " content");
    }
    vi.stubEnv("KOZANE_SSG", "1");
    vi.stubEnv("KOZANE_READONLY", "1");
    vi.stubEnv("KOZANE_WORKSPACE_ROOT", root);
    vi.stubEnv("KOZANE_SSG_INCLUDE_SCOPED_FILES", includeFiles ? "1" : "0");
    vi.resetModules();
    const [
      { createTestDB },
      { createNamespace },
      { getDefaultPartition },
      { addCard },
      { addScope },
      { addScopeRel },
      { addTaskspace },
    ] = await Promise.all([
      import("../../test-utils/db.js"),
      import("../../db/api/namespace.js"),
      import("../../db/api/partition.js"),
      import("../../db/api/card.js"),
      import("../../db/api/scope.js"),
      import("../../db/api/scope-rel.js"),
      import("../../db/api/taskspace.js"),
    ]);
    const db = await createTestDB();
    const namespaceId = await createNamespace({ db, name: "Export" });
    const partition = await getDefaultPartition({ db, namespaceId });
    const cardId = await addCard({ db, partitionId: partition!.id, content: "Card" });
    const scopeId = await addScope({ db, name: "Scoped" });
    await addScopeRel({ db, scopeId, cardId });
    const scoped = await addTaskspace({
      db,
      namespaceId,
      scopeId,
      name: "Scoped notes",
      path: "scoped",
    });
    const unlinked = await addTaskspace({
      db,
      namespaceId,
      name: "Unlinked private",
      path: "unlinked",
    });
    const { load } = await import("./+page.server.js");
    const data = (await load({ locals: { db }, params: { namespaceId } } as never)) as {
      staticBackendData: StaticBackendData;
      backendCapabilities?: unknown;
    };
    expect(data.backendCapabilities).toBeUndefined();
    expect(JSON.stringify(data.staticBackendData)).not.toContain(root);
    expect(JSON.stringify(data.staticBackendData)).not.toContain("Unlinked private");
    expect(data.staticBackendData.files?.[unlinked]).toBeUndefined();
    const backend = new StaticBackend(data.staticBackendData);
    expect(backend.capabilities.writable).toBe(false);
    if (includeFiles) {
      expect(Object.keys(data.staticBackendData.files ?? {})).toEqual([scoped]);
      expect(await backend.taskspaces!.readFile(namespaceId, scoped, "notes.md")).toMatchObject({
        content: "scoped content",
        signature: null,
      });
    } else {
      expect(data.staticBackendData.files).toBeUndefined();
      expect(data.staticBackendData.snapshots?.[0].scopes).toEqual([]);
      expect(backend.taskspaces).toBeUndefined();
    }
  },
);
