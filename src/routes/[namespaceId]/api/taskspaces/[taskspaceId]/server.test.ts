import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { DELETE, PATCH } from "./+server.js";
import { addNamespace } from "$db/api/namespace.js";
import { addScope } from "$db/api/scope.js";
import { addTaskspace, getTaskspace } from "$db/api/taskspace.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import type { DB } from "$db/tx.js";
import { _resetWorkspaceRootForTest } from "$db/internal/config.js";
import {
  TASKSPACE_MARKER_FILE,
  TASKSPACE_MARKER_KIND,
  TASKSPACE_MARKER_VERSION,
} from "../../../../../lib/taskspace-marker.js";

function event(db: DB, namespaceId: string, taskspaceId: string, method: string, body?: unknown) {
  const request = new Request(`http://localhost/${namespaceId}/api/taskspaces/${taskspaceId}`, {
    method,
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return { locals: { db }, params: { namespaceId, taskspaceId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

function writeMarker(dir: string, taskspaceId: string, namespaceId: string, owns = true) {
  writeFileSync(
    join(dir, TASKSPACE_MARKER_FILE),
    JSON.stringify({
      kind: TASKSPACE_MARKER_KIND,
      version: TASKSPACE_MARKER_VERSION,
      taskspaceId,
      namespaceId,
      ...(owns && { ownsDirectory: true }),
    }),
  );
}

describe("/[namespaceId]/api/taskspaces/[taskspaceId]", () => {
  let db: DB;
  let namespaceId: string;
  let taskspaceId: string;
  let tmpRoot: string;
  let prevEnv: string | undefined;

  /** Points the workspace's `taskspace.defaultDir` at `dir` and makes the folder. */
  function useDefaultDir(dir: string) {
    writeFileSync(
      join(tmpRoot, ".kozane", "config.json"),
      JSON.stringify({ name: "test", taskspace: { defaultDir: dir } }),
    );
    mkdirSync(join(tmpRoot, dir), { recursive: true });
    _resetWorkspaceRootForTest();
  }

  beforeEach(async () => {
    db = await createTestDB();
    namespaceId = await addNamespace({ db, name: "Test Namespace" });
    const scopeId = await addScope({ db, name: "Scope" });

    tmpRoot = join(tmpdir(), `kozane-taskspace-item-test-${randomUUID()}`);
    mkdirSync(join(tmpRoot, ".kozane"), { recursive: true });
    prevEnv = process.env.KOZANE_WORKSPACE_ROOT;
    process.env.KOZANE_WORKSPACE_ROOT = tmpRoot;
    useDefaultDir("tasks");

    taskspaceId = await addTaskspace({
      db,
      namespaceId,
      scopeId,
      name: "draft",
      path: join("tasks", "draft"),
    });
    mkdirSync(join(tmpRoot, "tasks", "draft", "notes"), { recursive: true });
    writeFileSync(join(tmpRoot, "tasks", "draft", "notes", "a.md"), "a");
    writeMarker(join(tmpRoot, "tasks", "draft"), taskspaceId, namespaceId);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.KOZANE_WORKSPACE_ROOT;
    else process.env.KOZANE_WORKSPACE_ROOT = prevEnv;
    _resetWorkspaceRootForTest();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("PATCH", () => {
    it("renames the record and moves its directory", async () => {
      const res = await PATCH(event(db, namespaceId, taskspaceId, "PATCH", { name: "final" }));

      expect(await res.json()).toMatchObject({ id: taskspaceId, name: "final" });
      expect(existsSync(join(tmpRoot, "tasks", "final", "notes", "a.md"))).toBe(true);
      expect(existsSync(join(tmpRoot, "tasks", "draft"))).toBe(false);
      const row = await getTaskspace({ db, taskspaceId });
      expect(row?.name).toBe("final");
      expect(row?.path).toBe(join("tasks", "final"));
    });

    it("refuses a name whose directory exists, leaving everything as it was", async () => {
      mkdirSync(join(tmpRoot, "tasks", "taken"));

      await expectHttpRejection(
        PATCH(event(db, namespaceId, taskspaceId, "PATCH", { name: "taken" })),
        409,
        "A directory with that name already exists",
      );
      expect((await getTaskspace({ db, taskspaceId }))?.name).toBe("draft");
      expect(existsSync(join(tmpRoot, "tasks", "draft", "notes"))).toBe(true);
    });

    it("refuses a name that is not one path segment", async () => {
      await expectHttpRejection(
        PATCH(event(db, namespaceId, taskspaceId, "PATCH", { name: "../up" })),
        400,
        "name must not contain '/', '\\', or NUL",
      );
    });

    it("changes only the label of a directory outside the default folder", async () => {
      const elsewhere = join(tmpRoot, "mine");
      mkdirSync(elsewhere);
      const id = await addTaskspace({ db, namespaceId, name: "mine", path: "mine" });

      await PATCH(event(db, namespaceId, id, "PATCH", { name: "Renamed label" }));

      expect(existsSync(elsewhere)).toBe(true);
      const row = await getTaskspace({ db, taskspaceId: id });
      expect(row).toMatchObject({ name: "Renamed label", path: "mine" });
    });

    it("changes only the label of a directory Kozane did not create", async () => {
      // `kozane taskspace create mine --dir src` with the default `defaultDir` of `.`.
      useDefaultDir(".");
      mkdirSync(join(tmpRoot, "src"));
      const id = await addTaskspace({ db, namespaceId, name: "mine", path: "src" });
      writeMarker(join(tmpRoot, "src"), id, namespaceId, false);

      const res = await PATCH(event(db, namespaceId, id, "PATCH", { name: "a/b label" }));

      expect(await res.json()).toMatchObject({ name: "a/b label", path: "src" });
      expect(existsSync(join(tmpRoot, "src", TASKSPACE_MARKER_FILE))).toBe(true);
    });

    it("404s when an owned directory is gone", async () => {
      rmSync(join(tmpRoot, "tasks", "draft"), { recursive: true });

      await expectHttpRejection(
        PATCH(event(db, namespaceId, taskspaceId, "PATCH", { name: "final" })),
        404,
        "Taskspace directory not found",
      );
      expect((await getTaskspace({ db, taskspaceId }))?.name).toBe("draft");
    });
  });

  describe("DELETE", () => {
    it("deletes the record and its directory", async () => {
      const res = await DELETE(event(db, namespaceId, taskspaceId, "DELETE"));

      expect(await res.json()).toEqual({ ok: true, directory: "deleted" });
      expect(existsSync(join(tmpRoot, "tasks", "draft"))).toBe(false);
      expect(existsSync(join(tmpRoot, "tasks"))).toBe(true);
      expect(await getTaskspace({ db, taskspaceId })).toBeUndefined();
    });

    it("deletes the record when the directory is already gone", async () => {
      rmSync(join(tmpRoot, "tasks", "draft"), { recursive: true });

      const res = await DELETE(event(db, namespaceId, taskspaceId, "DELETE"));

      expect(await res.json()).toEqual({ ok: true, directory: "missing" });
      expect(await getTaskspace({ db, taskspaceId })).toBeUndefined();
    });

    it("keeps everything when the marker names another taskspace", async () => {
      writeMarker(join(tmpRoot, "tasks", "draft"), "someone-else", namespaceId);

      await expectHttpRejection(
        DELETE(event(db, namespaceId, taskspaceId, "DELETE")),
        409,
        "The directory's .taskspace.json does not name this taskspace, so it was not deleted",
      );
      expect(existsSync(join(tmpRoot, "tasks", "draft", "notes", "a.md"))).toBe(true);
      expect(await getTaskspace({ db, taskspaceId })).toBeDefined();
    });

    it("keeps a directory Kozane did not create, even in the default folder", async () => {
      // `kozane taskspace create mine --dir src` with the default `defaultDir` of `.`.
      useDefaultDir(".");
      mkdirSync(join(tmpRoot, "src"));
      writeFileSync(join(tmpRoot, "src", "main.ts"), "code");
      const id = await addTaskspace({ db, namespaceId, name: "mine", path: "src" });
      writeMarker(join(tmpRoot, "src"), id, namespaceId, false);

      const res = await DELETE(event(db, namespaceId, id, "DELETE"));

      expect(await res.json()).toEqual({ ok: true, directory: "kept" });
      expect(readFileSync(join(tmpRoot, "src", "main.ts"), "utf-8")).toBe("code");
      expect(await getTaskspace({ db, taskspaceId: id })).toBeUndefined();
    });

    it("keeps everything when a managed path has no marker", async () => {
      rmSync(join(tmpRoot, "tasks", "draft", TASKSPACE_MARKER_FILE));

      await expectHttpRejection(
        DELETE(event(db, namespaceId, taskspaceId, "DELETE")),
        409,
        "The directory's .taskspace.json does not name this taskspace, so it was not deleted",
      );
      expect(existsSync(join(tmpRoot, "tasks", "draft", "notes", "a.md"))).toBe(true);
    });

    it("keeps a directory outside the default folder", async () => {
      mkdirSync(join(tmpRoot, "mine"));
      const id = await addTaskspace({ db, namespaceId, name: "mine", path: "mine" });
      writeMarker(join(tmpRoot, "mine"), id, namespaceId);

      const res = await DELETE(event(db, namespaceId, id, "DELETE"));

      expect(await res.json()).toEqual({ ok: true, directory: "kept" });
      expect(existsSync(join(tmpRoot, "mine", TASKSPACE_MARKER_FILE))).toBe(true);
    });

    it("keeps an absolute-path directory", async () => {
      const elsewhere = join(tmpdir(), `kozane-elsewhere-${randomUUID()}`);
      mkdirSync(elsewhere);
      try {
        const id = await addTaskspace({
          db,
          namespaceId,
          name: "away",
          path: elsewhere,
          pathKind: "absolute",
        });
        writeMarker(elsewhere, id, namespaceId);

        const res = await DELETE(event(db, namespaceId, id, "DELETE"));

        expect(await res.json()).toEqual({ ok: true, directory: "kept" });
        expect(readFileSync(join(elsewhere, TASKSPACE_MARKER_FILE), "utf-8")).toContain(id);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it("404s a taskspace from another namespace", async () => {
      const otherId = await addNamespace({ db, name: "Other" });

      await expectHttpRejection(
        DELETE(event(db, otherId, taskspaceId, "DELETE")),
        404,
        "Taskspace not found",
      );
      expect(existsSync(join(tmpRoot, "tasks", "draft"))).toBe(true);
    });
  });
});
