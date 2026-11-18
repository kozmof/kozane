import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDB } from "./test-utils/db.js";
import { addNamespace } from "./db/api/namespace.js";
import { addTaskspace, getTaskspace } from "./db/api/taskspace.js";
import { localFileOperationTable } from "./db/schema.js";
import { localClaimIntent } from "./lib/server/local-file-operations.js";
import { TASKSPACE_MARKER_FILE, taskspaceMarkerText } from "./lib/taskspace-marker.js";

const state = vi.hoisted(() => ({ root: "", db: undefined as unknown, building: false }));
vi.mock("./db/internal/config", () => ({
  getWorkspaceRoot: () => state.root,
  getDBURL: () => ":memory:",
}));
vi.mock("./db/client", () => ({ getDb: vi.fn(async () => state.db) }));
vi.mock("$app/environment", () => ({
  get building() {
    return state.building;
  },
}));
import { handle } from "./hooks.server";

let db: Awaited<ReturnType<typeof createTestDB>>;
let taskspaceId: string;
beforeEach(async () => {
  state.root = mkdtempSync(join(tmpdir(), "kozane-hook-claims-"));
  mkdirSync(join(state.root, ".kozane"));
  mkdirSync(join(state.root, "target"));
  db = await createTestDB();
  state.db = db;
  state.building = false;
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  taskspaceId = await addTaskspace({ db, namespaceId, name: "Detached" });
  await db.insert(localFileOperationTable).values({
    id: "pending-startup",
    kind: "taskspace.claim",
    version: 1,
    taskspaceId,
    namespaceId,
    path: "target",
    pathKind: "workspace_relative",
    state: "pending",
    createdAt: new Date(),
    intent: localClaimIntent(taskspaceId, namespaceId, {
      adoptExisting: false,
      parentsInside: true,
      ownIfCreated: true,
    }),
  });
  writeFileSync(
    join(state.root, "target", TASKSPACE_MARKER_FILE),
    taskspaceMarkerText(taskspaceId, namespaceId, true),
  );
  process.env.HOST = "127.0.0.1";
  delete process.env.KOZANE_SSG;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.KOZANE_SSG;
  rmSync(state.root, { recursive: true, force: true });
});
function request() {
  const url = new URL("http://localhost/");
  return handle({
    event: {
      url,
      request: new Request(url),
      locals: {},
      cookies: { get: () => undefined },
      getClientAddress: () => "127.0.0.1",
    } as never,
    resolve: vi.fn(async () => new Response("ok")) as never,
  });
}

it("reports pending claims once after database access and serves without attaching or changing files", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rows = await db.select().from(localFileOperationTable);
  const bytes = readFileSync(join(state.root, "target", TASKSPACE_MARKER_FILE));
  const responses = await Promise.all([request(), request(), request()]);
  expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0][0]).toContain("pending-startup (matching-marker)");
  expect(await db.select().from(localFileOperationTable)).toEqual(rows);
  expect(await getTaskspace({ db, taskspaceId })).toMatchObject({ path: null });
  expect(readFileSync(join(state.root, "target", TASKSPACE_MARKER_FILE))).toEqual(bytes);
});

it("does not inspect or reveal pending work before authentication", async () => {
  writeFileSync(
    join(state.root, ".kozane", "api.json"),
    JSON.stringify({ apiKey: "secret", createdAt: new Date().toISOString() }),
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const response = await request();
  expect(response.status).toBe(401);
  expect(warn).not.toHaveBeenCalled();
  expect(await getTaskspace({ db, taskspaceId })).toMatchObject({ path: null });
});

it("does not inspect claims during static prerendering", async () => {
  state.building = true;
  process.env.KOZANE_SSG = "1";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect((await request()).status).toBe(200);
  expect(warn).not.toHaveBeenCalled();
});
