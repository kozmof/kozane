import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { PATCH } from "./+server.js";
import { POST as createFile } from "../file/+server.js";
import { createTestDB } from "../../../../../../test-utils/db.js";
import type { DB } from "$db/tx.js";
import { addNamespace } from "$db/api/namespace.js";
import { addScope } from "$db/api/scope.js";
import { addTaskspace, getTaskspace, getAllTaskspaceLocalMetadata } from "$db/api/taskspace.js";
import { taskspaceTable } from "$db/schema.js";
import * as config from "$db/internal/config.js";
import { NAME_MAX } from "$lib/constants.js";
import {
  TASKSPACE_MARKER_FILE,
  TASKSPACE_MARKER_KIND,
  TASKSPACE_MARKER_VERSION,
} from "$lib/taskspace-marker.js";
import { HttpClient } from "../../../../../../../../client/src/client/http-client.js";

const failRead = vi.hoisted(() => ({ next: false }));
vi.mock("$db/api/taskspace", async (original) => {
  const real = await original<typeof import("$db/api/taskspace")>();
  return {
    ...real,
    getTaskspace: async (input: Parameters<typeof real.getTaskspace>[0]) => {
      if (failRead.next) {
        failRead.next = false;
        throw new Error("Reply read failed");
      }
      return real.getTaskspace(input);
    },
  };
});
let db: DB;
let namespaceId: string;
let taskspaceId: string;
let root: string;
let previousRoot: string | undefined;
const stamp = new Date(1600000000000);
function event(
  input: unknown,
  namespace = namespaceId,
  id = taskspaceId,
  contentType = "application/json",
) {
  return {
    locals: { db },
    params: { namespaceId: namespace, taskspaceId: id },
    request: new Request("http://localhost/label", {
      method: "PATCH",
      headers: { "content-type": contentType },
      body: JSON.stringify(input),
    }),
  } as never;
}
beforeEach(async () => {
  db = await createTestDB();
  namespaceId = await addNamespace({ db, name: "Namespace" });
  const scopeId = await addScope({ db, name: "Scope" });
  taskspaceId = await addTaskspace({
    db,
    namespaceId,
    scopeId,
    name: "draft",
    path: "tasks/draft",
    lastSeenAt: stamp,
  });
  await db
    .update(taskspaceTable)
    .set({ createdAt: stamp, updatedAt: stamp })
    .where(eq(taskspaceTable.id, taskspaceId));
  root = mkdtempSync(join(tmpdir(), "kozane-label-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(
    join(root, ".kozane", "config.json"),
    JSON.stringify({ name: "Test", taskspace: { defaultDir: "tasks", namespaceDirs: false } }),
  );
  mkdirSync(join(root, "tasks", "draft", "notes"), { recursive: true });
  writeFileSync(join(root, "tasks", "draft", "notes", "a.md"), "Content");
  writeFileSync(
    join(root, "tasks", "draft", TASKSPACE_MARKER_FILE),
    JSON.stringify({
      kind: TASKSPACE_MARKER_KIND,
      version: TASKSPACE_MARKER_VERSION,
      taskspaceId,
      namespaceId,
      ownsDirectory: true,
    }),
  );
  previousRoot = process.env.KOZANE_WORKSPACE_ROOT;
  process.env.KOZANE_WORKSPACE_ROOT = root;
  config._resetWorkspaceRootForTest();
});
afterEach(() => {
  failRead.next = false;
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.KOZANE_WORKSPACE_ROOT;
  else process.env.KOZANE_WORKSPACE_ROOT = previousRoot;
  config._resetWorkspaceRootForTest();
  rmSync(root, { recursive: true, force: true });
});

it("renames a managed taskspace label while preserving its directory, marker and local observations", async () => {
  const local = await getAllTaskspaceLocalMetadata({ db });
  const marker = readFileSync(join(root, "tasks", "draft", TASKSPACE_MARKER_FILE), "utf8");
  const reply = await PATCH(event({ name: "  Final / label  " }));
  expect(await reply.json()).toEqual({
    id: taskspaceId,
    name: "Final / label",
    path: "tasks/draft",
    pathKind: "workspace_relative",
  });
  expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
  expect(readFileSync(join(root, "tasks", "draft", TASKSPACE_MARKER_FILE), "utf8")).toBe(marker);
  expect(readFileSync(join(root, "tasks", "draft", "notes", "a.md"), "utf8")).toBe("Content");
  expect(existsSync(join(root, "tasks", "Final"))).toBe(false);
  const row = (await getTaskspace({ db, taskspaceId }))!;
  expect(row.createdAt).toEqual(stamp);
  expect(row.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
});

it("does not consult workspace or directory configuration", async () => {
  const workspace = vi.spyOn(config, "getWorkspaceRoot").mockImplementation(() => {
    throw new Error("No filesystem configuration");
  });
  const placement = vi.spyOn(config, "getTaskspacePlacementConfig").mockImplementation(() => {
    throw new Error("Invalid directory configuration");
  });
  expect((await PATCH(event({ name: "Changed" }))).status).toBe(200);
  expect(workspace).not.toHaveBeenCalled();
  expect(placement).not.toHaveBeenCalled();
});

it("renames labels with missing, unattached or externally attached directories", async () => {
  rmSync(join(root, "tasks", "draft"), { recursive: true });
  expect((await PATCH(event({ name: "Missing directory" }))).status).toBe(200);
  const detached = await addTaskspace({ db, namespaceId, name: "Detached" });
  expect(
    await (await PATCH(event({ name: "Detached label" }, namespaceId, detached))).json(),
  ).toMatchObject({ name: "Detached label", path: null });
  const external = await addTaskspace({
    db,
    namespaceId,
    name: "External",
    path: "/not-read-or-moved",
    pathKind: "absolute",
  });
  expect(
    await (await PATCH(event({ name: "External label" }, namespaceId, external))).json(),
  ).toMatchObject({ name: "External label", path: "/not-read-or-moved", pathKind: "absolute" });
});

it.each([
  { name: "" },
  { name: "   " },
  { name: "x".repeat(NAME_MAX + 1) },
  { name: "New", path: "other" },
  { name: "New", lastSeenAt: 123 },
])(
  "refuses invalid labels or local mutation fields without changing either table %#",
  async (input) => {
    const before = await getTaskspace({ db, taskspaceId });
    const local = await getAllTaskspaceLocalMetadata({ db });
    await expect(PATCH(event(input))).rejects.toMatchObject({ status: 400 });
    expect(await getTaskspace({ db, taskspaceId })).toEqual(before);
    expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
  },
);

it("enforces namespace visibility and permits unplaced taskspaces on an existing namespace", async () => {
  const other = await addNamespace({ db, name: "Other" });
  await expect(PATCH(event({ name: "Foreign" }, other))).rejects.toMatchObject({ status: 404 });
  await expect(PATCH(event({ name: "Missing" }, "missing"))).rejects.toMatchObject({ status: 404 });
  await expect(PATCH(event({ name: "Missing" }, namespaceId, "missing"))).rejects.toMatchObject({
    status: 404,
  });
  const unplaced = await addTaskspace({ db, name: "Unplaced" });
  expect((await PATCH(event({ name: "Visible" }, other, unplaced))).status).toBe(200);
});

it("rolls back the shared update if assembling the local reply fails", async () => {
  const before = await getTaskspace({ db, taskspaceId });
  const local = await getAllTaskspaceLocalMetadata({ db });
  failRead.next = true;
  await expect(PATCH(event({ name: "Uncommitted" }))).rejects.toThrow("Reply read failed");
  expect(await getTaskspace({ db, taskspaceId })).toEqual(before);
  expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
});

it("serializes simultaneous labels without changing the attachment", async () => {
  const replies = await Promise.all([PATCH(event({ name: "One" })), PATCH(event({ name: "Two" }))]);
  expect(await Promise.all(replies.map((reply) => reply.json()))).toMatchObject([
    { name: "One", path: "tasks/draft" },
    { name: "Two", path: "tasks/draft" },
  ]);
  expect(await getTaskspace({ db, taskspaceId })).toMatchObject({
    name: "Two",
    path: "tasks/draft",
    lastSeenAt: stamp,
  });
});

it("keeps file writes at the attached path during a label rename", async () => {
  const renaming = PATCH(event({ name: "Final label" }));
  const creating = createFile({
    locals: { db },
    params: { namespaceId, taskspaceId },
    request: new Request("http://localhost/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "new.md" }),
    }),
  } as never);
  expect((await renaming).status).toBe(200);
  expect((await creating).status).toBe(201);
  expect(existsSync(join(root, "tasks", "draft", "new.md"))).toBe(true);
  expect(existsSync(join(root, "tasks", "Final label"))).toBe(false);
});

it("serves the HttpClient label endpoint and publishes one successful invalidation", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    expect(String(url)).toBe(`/${namespaceId}/api/taskspaces/${taskspaceId}/label`);
    return PATCH({
      locals: { db },
      params: { namespaceId, taskspaceId },
      request: new Request(new URL(String(url), "http://localhost"), options),
    } as never);
  });
  const client = new HttpClient({
    capabilities: {
      writable: true,
      persistent: true,
      taskspaces: true,
      externalWrites: false,
      auth: false,
    },
    fetcher,
  });
  const listener = vi.fn();
  const release = client.subscribe(listener);
  try {
    expect(
      await client.taskspaces!.rename(namespaceId, taskspaceId, { name: "New label" }),
    ).toMatchObject({ id: taskspaceId, name: "New label", path: "tasks/draft" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect((await getTaskspace({ db, taskspaceId }))!.path).toBe("tasks/draft");
  } finally {
    release();
    client.dispose();
  }
});

it("requires a JSON object request before changing the label", async () => {
  await expect(
    PATCH(event({ name: "New" }, namespaceId, taskspaceId, "text/plain")),
  ).rejects.toMatchObject({ status: 415 });
  await expect(PATCH(event([]))).rejects.toMatchObject({ status: 400 });
  expect((await getTaskspace({ db, taskspaceId }))!.name).toBe("draft");
});
