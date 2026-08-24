import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { POST } from "./+server.js";
import { addProject } from "$db/api/project.js";
import { addScope } from "$db/api/scope.js";
import { getAllTaskspaces } from "$db/api/taskspace.js";
import { createTestDB } from "../../../../test-utils/db.js";
import type { DB } from "$db/tx.js";
import { TASKSPACE_MARKER_FILE } from "../../../../lib/taskspace-marker.js";
import { _resetWorkspaceRootForTest } from "$db/internal/config.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/taskspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, request: Request) {
  return { locals: { db }, params: { projectId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

describe("POST /[projectId]/api/taskspaces", () => {
  let db: DB;
  let projectId: string;
  let scopeId: string;
  let tmpRoot: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    db = await createTestDB();
    projectId = await addProject({ db, name: "Test Project" });
    scopeId = await addScope({ db, name: "My Scope" });

    tmpRoot = join(tmpdir(), `kozane-taskspace-test-${randomUUID()}`);
    mkdirSync(join(tmpRoot, ".kozane"), { recursive: true });
    writeFileSync(join(tmpRoot, ".kozane", "config.json"), JSON.stringify({ name: "test" }));

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

  it("rejects missing name", async () => {
    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ scopeId }))),
      400,
      "name is required",
    );
  });

  it("rejects blank name", async () => {
    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "   ", scopeId }))),
      400,
      "name is required",
    );
  });

  it("rejects missing scopeId", async () => {
    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "my-draft" }))),
      400,
      "scopeId is required",
    );
  });

  it("rejects path traversal via name", async () => {
    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "../../outside", scopeId }))),
      400,
      "Taskspace path must be inside the workspace root",
    );
  });

  it("creates the taskspace directory and marker file", async () => {
    const res = await POST(event(db, projectId, jsonRequest({ name: "my-draft", scopeId })));

    expect(res.status).toBe(200);
    const { id, path, pathKind } = await res.json();
    expect(id).toBeTruthy();
    expect(path).toBe("my-draft");
    expect(pathKind).toBe("project_relative");

    const markerPath = join(tmpRoot, "my-draft", TASKSPACE_MARKER_FILE);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    expect(marker.taskspaceId).toBe(id);
    expect(marker.projectId).toBe(projectId);
  });

  it("rejects an existing directory without changing its contents or creating a DB row", async () => {
    const target = join(tmpRoot, "existing");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "important");
    writeFileSync(join(target, TASKSPACE_MARKER_FILE), "original marker");

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "existing", scopeId }))),
      409,
      "Taskspace directory already exists",
    );

    expect(readFileSync(join(target, "keep.txt"), "utf-8")).toBe("important");
    expect(readFileSync(join(target, TASKSPACE_MARKER_FILE), "utf-8")).toBe("original marker");
    expect(await getAllTaskspaces({ db })).toHaveLength(0);
  });

  it("rejects an unknown project before touching the filesystem", async () => {
    await expectHttpRejection(
      POST(event(db, "missing-project", jsonRequest({ name: "missing", scopeId }))),
      404,
      "Project not found",
    );
    expect(existsSync(join(tmpRoot, "missing"))).toBe(false);
  });

  it("rejects an unknown scope before touching the filesystem", async () => {
    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "missing", scopeId: "missing-scope" }))),
      400,
      "Scope not found",
    );
    expect(existsSync(join(tmpRoot, "missing"))).toBe(false);
  });

  it("treats a file at the target path as a collision", async () => {
    // Create a regular file at the would-be target so mkdirSync throws ENOTDIR.
    writeFileSync(join(tmpRoot, "blocked"), "not a dir");

    // "blocked/sub" is inside the workspace root but mkdirSync fails because
    // "blocked" is a file, not a directory. The handler should compensate by
    // deleting the newly-inserted taskspace row and returning 500.
    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ name: "blocked/sub", scopeId }))),
      409,
      "Taskspace directory already exists",
    );
    expect(readFileSync(join(tmpRoot, "blocked"), "utf-8")).toBe("not a dir");
    expect(await getAllTaskspaces({ db })).toHaveLength(0);
  });
});
