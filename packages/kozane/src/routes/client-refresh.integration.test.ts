import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { idMatches } from "../lib/short-id-key.js";
import { getDb, resetDb } from "../db/client.js";
import { nodeCommitRevision } from "../db/tx.js";
import { _resetWorkspaceRootForTest } from "../db/internal/config.js";
import { addTaskspace } from "../db/api/taskspace.js";
import * as namespaces from "../services/namespaces.js";
import { workspaceServiceContext } from "../lib/server/service-context.js";
import { workspaceChangeToken } from "../lib/server/workspace-change-token.js";
import { _resetSnapshotEtagsForTest } from "../lib/server/snapshot-etag.js";
import {
  HttpClient,
  type SnapshotData,
  type TagsResult,
  type MapResult,
} from "../../../client/src/client/index.js";
import { TaskspaceTreeState } from "../../../client/src/board/lib/taskspace-tree.svelte.js";
import { startSnapshotView } from "../../../client/src/client/snapshot-view.js";
import { startDatasetView } from "../../../client/src/client/dataset-view.js";
import { GET as changes } from "./api/changes/+server.js";
import { GET as snapshot } from "./[namespaceId]/api/snapshot/+server.js";
import { GET as tags } from "./api/tags/+server.js";
import { GET as map } from "./api/map/+server.js";
import { POST as move } from "./[namespaceId]/api/cards/move/+server.js";
import { GET as files } from "./[namespaceId]/api/taskspaces/[taskspaceId]/files/+server.js";
const cliEntry = resolve("packages/kozane/src/cli/index.ts");
const loader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
let root: string | undefined;
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  resetDb();
  vi.unstubAllEnvs();
  _resetWorkspaceRootForTest();
  _resetSnapshotEtagsForTest();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
function cli(...args: string[]) {
  const env = {
    ...process.env,
    TMPDIR: tmpdir(),
    KOZANE_WORKSPACE_ROOT: root,
    DATABASE_URL: undefined,
    KOZANE_RUNTIME_DATABASE_URL: undefined,
    KOZANE_MEMORY_MODE: undefined,
  };
  const result = spawnSync(process.execPath, ["--import", loader, cliEntry, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.status !== 0)
    throw new Error(`CLI failed: ${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  return result.stdout;
}
it("refreshes real HTTP views after external CLI commits and token-stable file changes", async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-client-refresh-"));
  cli("init");
  const dbUrl = `file:${join(root, ".kozane", "kozane.db")}`;
  vi.stubEnv("DATABASE_URL", dbUrl);
  vi.stubEnv("KOZANE_WORKSPACE_ROOT", root);
  vi.stubEnv("KOZANE_READONLY", "0");
  _resetWorkspaceRootForTest();
  const db = await getDb();
  const context = workspaceServiceContext();
  const first = (await namespaces.list(db, context))[0];
  const second = await namespaces.create(db, context, { name: "Second" });
  const directory = join(root, "notes");
  mkdirSync(directory);
  writeFileSync(join(directory, "before.md"), "Notes :files:before\n");
  const taskspaceId = await addTaskspace({
    db,
    namespaceId: first.id,
    name: "Notes",
    path: "notes",
    pathKind: "workspace_relative",
  });
  const requests: { path: string; status: number; conditional: boolean }[] = [];
  let dispatched = 0;
  let visible = true;
  let wake!: () => void;
  const lifecycleStop = vi.fn();
  let holdBaseline = true;
  let fixedToken: string | undefined;
  let answerBaseline!: () => void;
  let baselineCaptured = false;
  const client = new HttpClient({
    capabilities: {
      writable: true,
      persistent: true,
      taskspaces: true,
      externalWrites: true,
      auth: false,
    },
    pollingInitialDelayMs: 60000,
    lifecycle: {
      visible: () => visible,
      listen(callback) {
        wake = callback;
        return lifecycleStop;
      },
    },
    fetcher: async (input, init) => {
      dispatched++;
      const url = new URL(String(input), "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const params = { namespaceId: parts[0], taskspaceId: parts[3] };
      const event = { locals: { db }, params, url, request: new Request(url, init) };
      const handler =
        url.pathname === "/api/changes"
          ? changes
          : url.pathname === "/api/tags"
            ? tags
            : url.pathname === "/api/map"
              ? map
              : parts.at(-1) === "snapshot"
                ? snapshot
                : parts.at(-1) === "move"
                  ? move
                  : parts.at(-1) === "files"
                    ? files
                    : undefined;
      if (!handler) throw new Error(`Unexpected client route: ${url.pathname}`);
      const actual = await handler(event as never);
      // libsql can omit -shm and produce conservative changing tokens. Pin this
      // response only for the filesystem-only leg to exercise unchanged polling.
      const response =
        url.pathname === "/api/changes" && fixedToken
          ? Response.json({ token: fixedToken })
          : actual;
      requests.push({
        path: url.pathname,
        status: response.status,
        conditional: new Headers(init?.headers).has("if-none-match"),
      });
      if (url.pathname === "/api/changes" && holdBaseline) {
        baselineCaptured = true;
        await new Promise<void>((resolve) => {
          answerBaseline = resolve;
        });
      }
      return response;
    },
  });
  const tree = new TaskspaceTreeState();
  const contextForFiles = { client, namespaceId: first.id };
  releases.push(tree.watch(taskspaceId, ""));
  releases.push(
    startDatasetView({
      client,
      dataset: "snapshot",
      isHidden: () => !visible,
      retryIntervalMs: 20,
      read: async () => {
        await tree.refreshWatched(contextForFiles, () => visible);
      },
      apply: () => {},
    }),
  );
  const seeded = await client.snapshot(first.id);
  expect(seeded.status).toBe("changed");
  let firstView: SnapshotData | undefined = seeded.status === "changed" ? seeded.data : undefined;
  let secondView: SnapshotData | undefined;
  let tagView: TagsResult | undefined;
  let mapView: MapResult | undefined;
  releases.push(
    startSnapshotView({
      client,
      namespaceId: () => first.id,
      initialDataApplied: true,
      activities: [],
      apply: (value) => {
        firstView = value;
      },
      isHidden: () => !visible,
      retryIntervalMs: 20,
    }),
  );
  releases.push(
    startSnapshotView({
      client,
      namespaceId: () => second.id,
      activities: [],
      apply: (value) => {
        secondView = value;
      },
      isHidden: () => !visible,
      retryIntervalMs: 20,
    }),
  );
  releases.push(
    startDatasetView({
      client,
      dataset: "tags",
      read: () => client.tags.get(),
      apply: (value) => {
        tagView = value;
      },
      isHidden: () => !visible,
      retryIntervalMs: 20,
    }),
  );
  releases.push(
    startDatasetView({
      client,
      dataset: "map",
      read: () => client.map.get(),
      apply: (value) => {
        mapView = value;
      },
      isHidden: () => !visible,
      retryIntervalMs: 20,
    }),
  );
  await vi.waitFor(() => {
    expect(tagView).toBeDefined();
    expect(mapView).toBeDefined();
    expect(secondView).toBeDefined();
  });
  wake();
  await vi.waitFor(() => expect(baselineCaptured).toBe(true));
  const revision = nodeCommitRevision(db).revision;
  const before = workspaceChangeToken(db, dbUrl);
  const output = cli("card", "add", "External card :external", "--namespace", first.id);
  const shortId = output.match(/^\s*id\s*:\s*(\S+)/m)?.[1];
  expect(shortId).toBeTruthy();
  expect(nodeCommitRevision(db).revision).toBe(revision);
  expect(workspaceChangeToken(db, dbUrl)).not.toBe(before);
  holdBaseline = false;
  answerBaseline();
  await vi.waitFor(() =>
    expect(firstView?.cards.some((card) => idMatches(shortId!, card.id))).toBe(true),
  );
  const cardId = firstView!.cards.find((card) => idMatches(shortId!, card.id))!.id;
  await vi.waitFor(() =>
    expect(tagView?.index.hits.some((hit) => hit.tag === "external")).toBe(true),
  );
  const validator = (await client.snapshot(first.id)).validator;
  expect((await client.snapshot(first.id, { validator })).status).toBe("unchanged");
  expect(requests.some((request) => request.status === 304 && request.conditional)).toBe(true);

  await client.cards.move(first.id, { cardIds: [cardId!], targetNamespaceId: second.id });
  await vi.waitFor(() => {
    expect(firstView?.cards.some((card) => card.id === cardId)).toBe(false);
    expect(secondView?.cards.some((card) => card.id === cardId)).toBe(true);
    expect(
      mapView?.partitions
        .filter((row) => row.namespaceId === second.id)
        .reduce((sum, row) => sum + row.cards, 0),
    ).toBe(1);
  });
  // Establish the post-mutation baseline before changing files without a DB write.
  fixedToken = "filesystem-baseline";
  const baselineRevision = client.version.revision;
  wake();
  await vi.waitFor(() =>
    expect(requests.filter((request) => request.path === "/api/changes").length).toBeGreaterThan(1),
  );
  await vi.waitFor(() => expect(client.version.revision).toBeGreaterThan(baselineRevision));
  const unchangedRevision = nodeCommitRevision(db).revision;
  renameSync(join(directory, "before.md"), join(directory, "after.md"));
  writeFileSync(join(directory, "after.md"), "Notes :files:after\n");
  expect(nodeCommitRevision(db).revision).toBe(unchangedRevision);
  visible = false;
  wake();
  expect(tagView?.index.hits.some((hit) => hit.tag === "files:after")).toBe(false);
  visible = true;
  wake();
  await vi.waitFor(() =>
    expect(
      tagView?.index.hits.some(
        (hit) =>
          hit.tag === "files:after" && hit.source.kind === "file" && hit.source.path === "after.md",
      ),
    ).toBe(true),
  );
  await vi.waitFor(() =>
    expect(tree.node(taskspaceId, "").entries?.map((entry) => entry.name)).toEqual(["after.md"]),
  );
  expect(
    (await client.taskspaces!.list(first.id, taskspaceId, "")).entries.map((entry) => entry.name),
  ).toEqual(["after.md"]);
  for (const release of releases.splice(0).reverse()) release();
  expect(lifecycleStop).toHaveBeenCalledOnce();
  const count = dispatched;
  wake();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(dispatched).toBe(count);
}, 30000);
