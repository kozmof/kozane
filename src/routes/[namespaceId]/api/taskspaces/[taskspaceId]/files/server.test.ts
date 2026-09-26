import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { GET, POST } from "./+server.js";
import { addNamespace } from "$db/api/namespace.js";
import { addTaskspace } from "$db/api/taskspace.js";
import { createTestDB } from "../../../../../../test-utils/db.js";
import type { DB } from "$db/tx.js";
import { _resetWorkspaceRootForTest } from "$db/internal/config.js";
import type { TaskspaceListing } from "$lib/types";

function event(db: DB, namespaceId: string, taskspaceId: string, path?: string) {
  const url = new URL(`http://localhost/${namespaceId}/api/taskspaces/${taskspaceId}/files`);
  if (path !== undefined) url.searchParams.set("path", path);
  return { locals: { db }, params: { namespaceId, taskspaceId }, url } as never;
}

function postEvent(db: DB, namespaceId: string, taskspaceId: string, payload: unknown) {
  const request = new Request(
    `http://localhost/${namespaceId}/api/taskspaces/${taskspaceId}/files`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    },
  );
  return { locals: { db }, params: { namespaceId, taskspaceId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function listing(value: unknown): Promise<TaskspaceListing> {
  return (await (value as Promise<Response>)).json();
}

type Fixture = { db: DB; namespaceId: string; taskspaceId: string; tmpRoot: string };

/** The workspace both describes run against: a `demo` taskspace with a file and a folder. */
async function makeWorkspace(): Promise<Fixture> {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Test Namespace" });

  const tmpRoot = join(tmpdir(), `kozane-files-route-test-${randomUUID()}`);
  mkdirSync(join(tmpRoot, ".kozane"), { recursive: true });
  writeFileSync(join(tmpRoot, ".kozane", "config.json"), JSON.stringify({ name: "test" }));
  mkdirSync(join(tmpRoot, "demo", "src"), { recursive: true });
  writeFileSync(join(tmpRoot, "demo", "README.md"), "hello");
  writeFileSync(join(tmpRoot, "demo", ".taskspace.json"), "{}");
  writeFileSync(join(tmpRoot, "demo", "src", "app.ts"), "export {}");

  const taskspaceId = await addTaskspace({ db, namespaceId, name: "demo", path: "demo" });
  return { db, namespaceId, taskspaceId, tmpRoot };
}

describe("GET /[namespaceId]/api/taskspaces/[taskspaceId]/files", () => {
  let db: DB;
  let namespaceId: string;
  let taskspaceId: string;
  let tmpRoot: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    ({ db, namespaceId, taskspaceId, tmpRoot } = await makeWorkspace());

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

  it("lists the taskspace root, hiding the marker file", async () => {
    const body = await listing(GET(event(db, namespaceId, taskspaceId)));
    expect(body.path).toBe("");
    expect(body.entries.map(({ name }) => name)).toEqual(["src", "README.md"]);
    expect(body.truncated).toBe(false);
  });

  it("lists a subdirectory", async () => {
    const body = await listing(GET(event(db, namespaceId, taskspaceId, "src")));
    expect(body.path).toBe("src");
    expect(body.entries.map(({ name }) => name)).toEqual(["app.ts"]);
  });

  it("lists a taskspace stored with an absolute path outside the workspace root", async () => {
    const elsewhere = join(tmpdir(), `kozane-elsewhere-${randomUUID()}`);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "note.md"), "away");
    const id = await addTaskspace({
      db,
      namespaceId,
      name: "away",
      path: elsewhere,
      pathKind: "absolute",
    });

    try {
      const body = await listing(GET(event(db, namespaceId, id)));
      expect(body.entries.map(({ name }) => name)).toEqual(["note.md"]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("rejects a path that walks out of the taskspace", async () => {
    await expectHttpRejection(
      GET(event(db, namespaceId, taskspaceId, "../.kozane")),
      400,
      "Path must stay inside the taskspace",
    );
  });

  it("404s an unknown namespace", async () => {
    await expectHttpRejection(
      GET(event(db, randomUUID(), taskspaceId)),
      404,
      "Namespace not found",
    );
  });

  it("404s an unknown taskspace", async () => {
    await expectHttpRejection(
      GET(event(db, namespaceId, randomUUID())),
      404,
      "Taskspace not found",
    );
  });

  it("404s a taskspace belonging to another namespace", async () => {
    const otherNamespaceId = await addNamespace({ db, name: "Other Namespace" });
    const otherTaskspaceId = await addTaskspace({
      db,
      namespaceId: otherNamespaceId,
      name: "demo",
      path: "demo",
    });

    // The directory is real and readable — what refuses this is the namespace the endpoint
    // is addressed to, not the filesystem boundary underneath it.
    await expectHttpRejection(
      GET(event(db, namespaceId, otherTaskspaceId)),
      404,
      "Taskspace not found",
    );
  });

  it("lists a taskspace assigned to no namespace from any namespace's endpoint", async () => {
    // Unplaced rather than somebody else's: `getTaskspacesInNamespace` draws these on every
    // board, so the endpoints behind that panel have to answer about them too.
    const unassignedId = await addTaskspace({ db, name: "demo", path: "demo" });

    const result = await listing(GET(event(db, namespaceId, unassignedId)));

    expect(result.entries.map((entry) => entry.name)).toContain("README.md");
  });

  it("404s a taskspace with no stored path", async () => {
    const id = await addTaskspace({ db, namespaceId, name: "pathless" });
    await expectHttpRejection(GET(event(db, namespaceId, id)), 404, "Taskspace has no directory");
  });

  it("404s a taskspace whose directory is gone", async () => {
    rmSync(join(tmpRoot, "demo"), { recursive: true, force: true });
    await expectHttpRejection(
      GET(event(db, namespaceId, taskspaceId)),
      404,
      "Taskspace directory not found",
    );
  });

  it("503s when there is no workspace", async () => {
    delete process.env.KOZANE_WORKSPACE_ROOT;
    process.env.KOZANE_WORKSPACE_ROOT = join(tmpdir(), `kozane-absent-${randomUUID()}`);
    _resetWorkspaceRootForTest();
    await expectHttpRejection(
      GET(event(db, namespaceId, taskspaceId)),
      503,
      "No Kozane workspace found. Run 'kozane init' first.",
    );
  });
});

describe("POST /[namespaceId]/api/taskspaces/[taskspaceId]/files", () => {
  let db: DB;
  let namespaceId: string;
  let taskspaceId: string;
  let tmpRoot: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    ({ db, namespaceId, taskspaceId, tmpRoot } = await makeWorkspace());

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

  it("creates a directory and answers 201 with the empty listing of it", async () => {
    const res = (await POST(postEvent(db, namespaceId, taskspaceId, { path: "docs" }))) as Response;
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: "docs", entries: [], truncated: false });
    expect(lstatSync(join(tmpRoot, "demo", "docs")).isDirectory()).toBe(true);
  });

  it("creates a directory inside another", async () => {
    await POST(postEvent(db, namespaceId, taskspaceId, { path: "src/lib" }));
    expect(lstatSync(join(tmpRoot, "demo", "src", "lib")).isDirectory()).toBe(true);
  });

  it("answers with a listing the GET of the same path agrees with", async () => {
    await POST(postEvent(db, namespaceId, taskspaceId, { path: "docs" }));
    expect(await listing(GET(event(db, namespaceId, taskspaceId, "docs")))).toEqual({
      path: "docs",
      entries: [],
      truncated: false,
    });
  });

  it("answers 409 for a name already taken", async () => {
    await expectHttpRejection(
      POST(postEvent(db, namespaceId, taskspaceId, { path: "src" })),
      409,
      "Directory already exists",
    );
    await expectHttpRejection(
      POST(postEvent(db, namespaceId, taskspaceId, { path: "README.md" })),
      409,
      "Directory already exists",
    );
  });

  it("answers 400 for a path that leaves the taskspace", async () => {
    await expectHttpRejection(
      POST(postEvent(db, namespaceId, taskspaceId, { path: "../owned" })),
      400,
      "Path must stay inside the taskspace",
    );
    expect(readdirSync(tmpRoot).includes("owned")).toBe(false);
  });

  it("answers 400 for a dot-entry", async () => {
    await expectHttpRejection(
      POST(postEvent(db, namespaceId, taskspaceId, { path: ".git" })),
      400,
      "Dot-entries cannot be opened",
    );
  });

  it("answers 400 when no path is given", async () => {
    await expectHttpRejection(
      POST(postEvent(db, namespaceId, taskspaceId, {})),
      400,
      "path is required",
    );
  });

  it("answers 404 rather than creating intermediate directories", async () => {
    await expectHttpRejection(
      POST(postEvent(db, namespaceId, taskspaceId, { path: "a/b/c" })),
      404,
      "Directory not found",
    );
    expect(readdirSync(join(tmpRoot, "demo")).includes("a")).toBe(false);
  });

  it("404s a taskspace another namespace owns", async () => {
    const other = await addNamespace({ db, name: "Other" });
    await expectHttpRejection(
      POST(postEvent(db, other, taskspaceId, { path: "docs" })),
      404,
      "Taskspace not found",
    );
  });
});
