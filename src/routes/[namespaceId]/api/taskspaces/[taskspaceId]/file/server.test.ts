import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { GET, PUT } from "./+server.js";
import { addNamespace } from "$db/api/namespace.js";
import { addTaskspace } from "$db/api/taskspace.js";
import { createTestDB } from "../../../../../../test-utils/db.js";
import type { DB } from "$db/tx.js";
import { _resetWorkspaceRootForTest } from "$db/internal/config.js";
import { TASKSPACE_FILE_BYTES_MAX } from "$lib/constants";

type Body = { path: string; content: string; signature: string | null };

function getEvent(db: DB, namespaceId: string, taskspaceId: string, path?: string) {
  const url = new URL(`http://localhost/${namespaceId}/api/taskspaces/${taskspaceId}/file`);
  if (path !== undefined) url.searchParams.set("path", path);
  return { locals: { db }, params: { namespaceId, taskspaceId }, url } as never;
}

function putEvent(db: DB, namespaceId: string, taskspaceId: string, payload: unknown) {
  const request = new Request(
    `http://localhost/${namespaceId}/api/taskspaces/${taskspaceId}/file`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    },
  );
  return { locals: { db }, params: { namespaceId, taskspaceId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function body(value: unknown): Promise<Body> {
  return (await (value as Promise<Response>)).json();
}

describe("/[namespaceId]/api/taskspaces/[taskspaceId]/file", () => {
  let db: DB;
  let namespaceId: string;
  let taskspaceId: string;
  let tmpRoot: string;
  let demo: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    db = await createTestDB();
    namespaceId = await addNamespace({ db, name: "Test Namespace" });

    tmpRoot = join(tmpdir(), `kozane-file-route-test-${randomUUID()}`);
    demo = join(tmpRoot, "demo");
    mkdirSync(join(tmpRoot, ".kozane"), { recursive: true });
    writeFileSync(join(tmpRoot, ".kozane", "config.json"), JSON.stringify({ name: "test" }));
    mkdirSync(join(demo, "src"), { recursive: true });
    writeFileSync(join(demo, "README.md"), "hello\n");
    writeFileSync(join(demo, ".taskspace.json"), "{}");
    writeFileSync(join(demo, "src", "app.ts"), "export {}\n");
    mkdirSync(join(tmpRoot, "outside"), { recursive: true });
    writeFileSync(join(tmpRoot, "outside", "secret.txt"), "not yours");

    taskspaceId = await addTaskspace({ db, namespaceId, name: "demo", path: "demo" });

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

  describe("GET", () => {
    it("reads a file in the taskspace root", async () => {
      const file = await body(GET(getEvent(db, namespaceId, taskspaceId, "README.md")));
      expect(file).toMatchObject({ path: "README.md", content: "hello\n" });
      expect(file.signature).toEqual(expect.any(String));
    });

    it("reads a file in a subdirectory", async () => {
      const file = await body(GET(getEvent(db, namespaceId, taskspaceId, "src/app.ts")));
      expect(file).toMatchObject({ path: "src/app.ts", content: "export {}\n" });
    });

    it("answers 400 for a path that leaves the taskspace", async () => {
      await expectHttpRejection(
        GET(getEvent(db, namespaceId, taskspaceId, "../outside/secret.txt")),
        400,
        "Path must stay inside the taskspace",
      );
    });

    it("answers 400 for the marker file the listing hides", async () => {
      await expectHttpRejection(
        GET(getEvent(db, namespaceId, taskspaceId, ".taskspace.json")),
        400,
        "Dot-entries cannot be opened",
      );
    });

    it("answers 400 when no path is given", async () => {
      await expectHttpRejection(GET(getEvent(db, namespaceId, taskspaceId)), 400, "No file named");
    });

    it("answers 400 for a symlink", async () => {
      symlinkSync(join(tmpRoot, "outside", "secret.txt"), join(demo, "escape.txt"));
      await expectHttpRejection(
        GET(getEvent(db, namespaceId, taskspaceId, "escape.txt")),
        400,
        "Symbolic links cannot be opened",
      );
    });

    it("answers 404 for a missing file", async () => {
      await expectHttpRejection(
        GET(getEvent(db, namespaceId, taskspaceId, "nope.md")),
        404,
        "File not found",
      );
    });

    it("answers 413 for a file over the size cap", async () => {
      writeFileSync(join(demo, "big.txt"), "x".repeat(TASKSPACE_FILE_BYTES_MAX + 1));
      await expectHttpRejection(
        GET(getEvent(db, namespaceId, taskspaceId, "big.txt")),
        413,
        `File is larger than ${TASKSPACE_FILE_BYTES_MAX} bytes`,
      );
    });

    it("answers 415 for a file that is not UTF-8 text", async () => {
      writeFileSync(join(demo, "data.bin"), Buffer.from([0x00, 0x01, 0x02]));
      await expectHttpRejection(
        GET(getEvent(db, namespaceId, taskspaceId, "data.bin")),
        415,
        "File is not UTF-8 text",
      );
    });

    it("answers 404 for an unknown namespace", async () => {
      await expectHttpRejection(
        GET(getEvent(db, "missing-namespace", taskspaceId, "README.md")),
        404,
        "Namespace not found",
      );
    });

    it("answers 404 for an unknown taskspace", async () => {
      await expectHttpRejection(
        GET(getEvent(db, namespaceId, "missing-taskspace", "README.md")),
        404,
        "Taskspace not found",
      );
    });

    it("answers 404 for a taskspace belonging to another namespace", async () => {
      const otherNamespaceId = await addNamespace({ db, name: "Other Namespace" });
      const otherTaskspaceId = await addTaskspace({
        db,
        namespaceId: otherNamespaceId,
        name: "demo",
        path: "demo",
      });

      // The file is there and readable; the namespace the endpoint is addressed to is what
      // refuses it, the way every other namespace-scoped endpoint here does.
      await expectHttpRejection(
        GET(getEvent(db, namespaceId, otherTaskspaceId, "README.md")),
        404,
        "Taskspace not found",
      );
    });

    it("reads a taskspace assigned to no namespace from any namespace's endpoint", async () => {
      // Unplaced rather than another namespace's, and drawn on every board — so the file
      // endpoint behind that panel has to answer about it too.
      const unassignedId = await addTaskspace({ db, name: "demo", path: "demo" });

      expect((await body(GET(getEvent(db, namespaceId, unassignedId, "README.md")))).content).toBe(
        "hello\n",
      );
    });
  });

  describe("PUT", () => {
    async function open(path: string): Promise<Body> {
      return body(GET(getEvent(db, namespaceId, taskspaceId, path)));
    }

    it("saves over a file and reports the new signature", async () => {
      const opened = await open("README.md");
      const saved = await body(
        PUT(
          putEvent(db, namespaceId, taskspaceId, {
            path: "README.md",
            content: "rewritten\n",
            signature: opened.signature,
          }),
        ),
      );

      expect(saved).toMatchObject({ path: "README.md", content: "rewritten\n" });
      expect(saved.signature).not.toBe(opened.signature);
      expect(readFileSync(join(demo, "README.md"), "utf-8")).toBe("rewritten\n");
    });

    it("saves multi-byte text unchanged", async () => {
      const opened = await open("README.md");
      await PUT(
        putEvent(db, namespaceId, taskspaceId, {
          path: "README.md",
          content: "こざね\n",
          signature: opened.signature,
        }),
      );
      expect(readFileSync(join(demo, "README.md"), "utf-8")).toBe("こざね\n");
    });

    it("answers 409 when the file changed on disk since it was opened", async () => {
      const opened = await open("README.md");
      writeFileSync(join(demo, "README.md"), "changed underneath\n");

      await expectHttpRejection(
        PUT(
          putEvent(db, namespaceId, taskspaceId, {
            path: "README.md",
            content: "mine\n",
            signature: opened.signature,
          }),
        ),
        409,
        "File changed on disk since it was opened",
      );
      expect(readFileSync(join(demo, "README.md"), "utf-8")).toBe("changed underneath\n");
    });

    it("answers 400 for a path that leaves the taskspace", async () => {
      await expectHttpRejection(
        PUT(
          putEvent(db, namespaceId, taskspaceId, {
            path: "../outside/secret.txt",
            content: "owned",
            signature: null,
          }),
        ),
        400,
        "Path must stay inside the taskspace",
      );
      expect(readFileSync(join(tmpRoot, "outside", "secret.txt"), "utf-8")).toBe("not yours");
    });

    it("answers 404 rather than creating a file that is not there", async () => {
      await expectHttpRejection(
        PUT(
          putEvent(db, namespaceId, taskspaceId, {
            path: "new.md",
            content: "hi",
            signature: null,
          }),
        ),
        404,
        "File not found",
      );
    });

    it("answers 400 when the signature is missing", async () => {
      await expectHttpRejection(
        PUT(putEvent(db, namespaceId, taskspaceId, { path: "README.md", content: "hi" })),
        400,
        "signature is required",
      );
    });

    it("answers 400 when the content is missing", async () => {
      await expectHttpRejection(
        PUT(putEvent(db, namespaceId, taskspaceId, { path: "README.md", signature: null })),
        400,
        "content is required",
      );
    });

    it("answers 415 for content holding a NUL byte", async () => {
      const opened = await open("README.md");
      await expectHttpRejection(
        PUT(
          putEvent(db, namespaceId, taskspaceId, {
            path: "README.md",
            content: "bad\u0000bytes",
            signature: opened.signature,
          }),
        ),
        415,
        "Content is not UTF-8 text",
      );
    });

    it("accepts empty content, which empties the file", async () => {
      const opened = await open("README.md");
      await PUT(
        putEvent(db, namespaceId, taskspaceId, {
          path: "README.md",
          content: "",
          signature: opened.signature,
        }),
      );
      expect(readFileSync(join(demo, "README.md"), "utf-8")).toBe("");
    });
  });
});
