import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addTaskspace } from "../../../db/api/taskspace.js";
import { _resetWorkspaceRootForTest } from "../../../db/internal/config.js";
import { expect, it, vi } from "vitest";
import { createTestDB } from "../../../test-utils/db.js";
import { createNamespace } from "../../../db/api/namespace.js";
import { getDefaultPartition } from "../../../db/api/partition.js";
import { create } from "../../../services/cards.js";
import { createServiceContext } from "../../../services/context.js";
import { readTagsViewData } from "../../../../packages/client/src/backend/decoders/tags.js";
import { GET } from "./+server";
import { GET as getMap } from "../map/+server";
it("serves shared tag and map datasets and rejects unknown destinations", async () => {
  const db = await createTestDB();
  const namespaceId = await createNamespace({ db, name: "View fixture" });
  const partition = await getDefaultPartition({ db, namespaceId });
  await create(db, createServiceContext(), namespaceId, {
    partitionId: partition!.id,
    content: "View card #topic",
  });
  const event = {
    locals: { db },
    url: new URL("http://localhost/api/tags?namespaceId=" + namespaceId),
  } as Parameters<typeof GET>[0];
  const tags = await (await GET(event)).json();
  expect(readTagsViewData(tags)).not.toBeNull();
  expect(tags.namespaces[0].id).toBe(namespaceId);
  expect(tags.index.cardNamespaces).toBeDefined();
  expect(tags.partitions).toBeDefined();
  const map = await (await getMap({ locals: { db } } as Parameters<typeof getMap>[0])).json();
  expect(map.namespaces[0].id).toBe(namespaceId);
  expect(map.partitions[0].cards).toBe(1);
  await expect(
    GET({ ...event, url: new URL("http://localhost/api/tags?namespaceId=missing") }),
  ).rejects.toMatchObject({ status: 404 });
});

it("revalidates filesystem edits, renames, deletion and missing roots without a database write", async () => {
  const root = mkdtempSync(join(tmpdir(), "kozane-tag-refresh-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(join(root, ".kozane", "config.json"), "{}");
  mkdirSync(join(root, "notes"));
  vi.stubEnv("KOZANE_WORKSPACE_ROOT", root);
  _resetWorkspaceRootForTest();
  try {
    const db = await createTestDB();
    const namespaceId = await createNamespace({ db, name: "Files" });
    const taskspaceId = await addTaskspace({ db, namespaceId, name: "Notes", path: "notes" });
    const event = {
      locals: { db },
      url: new URL("http://localhost/api/tags?namespaceId=" + namespaceId),
    } as Parameters<typeof GET>[0];
    const read = async () => {
      const data = readTagsViewData(await (await GET(event)).json());
      expect(data).not.toBeNull();
      return data!;
    };
    writeFileSync(join(root, "notes", "one.md"), ":perf old");
    expect((await read()).index.hits[0].excerpt).toBe(":perf old");
    writeFileSync(join(root, "notes", "one.md"), ":perf freshly edited");
    expect((await read()).index.hits[0].excerpt).toBe(":perf freshly edited");
    renameSync(join(root, "notes", "one.md"), join(root, "notes", "renamed.md"));
    expect((await read()).index.hits[0].source).toMatchObject({ kind: "file", path: "renamed.md" });
    rmSync(join(root, "notes", "renamed.md"));
    expect((await read()).index.hits).toEqual([]);
    rmSync(join(root, "notes"), { recursive: true });
    expect((await read()).index.missing).toEqual([taskspaceId]);
  } finally {
    vi.unstubAllEnvs();
    _resetWorkspaceRootForTest();
    rmSync(root, { recursive: true, force: true });
  }
});
