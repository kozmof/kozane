import { describe, it, expect, vi } from "vitest";
import type { TaskspaceFileTree } from "$lib/types";
import { EditorSession } from "./editor-session.svelte.js";

const REF = { taskspaceId: "ts-1", taskspaceName: "demo", path: "notes.md" };

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function fail(status: number, message: string) {
  return new Response(JSON.stringify({ message }), { status });
}

/** Answers GET with `read` and PUT with `write`, and records what it was sent. */
function fetcherFor({ read, write }: { read?: Response[]; write?: Response[] } = {}) {
  const reads = [...(read ?? [ok({ path: REF.path, content: "hello\n", signature: "sig-1" })])];
  const writes = [...(write ?? [ok({ path: REF.path, content: "", signature: "sig-2" })])];
  const calls: { method: string; url: string; body: unknown }[] = [];

  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = method === "GET" ? reads.shift() : writes.shift();
    return next ?? fail(500, "unexpected call");
  });

  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

/**
 * Answers each GET with "a\n" and a fresh signature, sig-1, sig-2, and so on, and holds each
 * PUT until the test answers it. Records the body of each PUT.
 */
function heldSaves() {
  const held: ((res: Response) => void)[] = [];
  const bodies: unknown[] = [];
  let reads = 0;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") {
      reads++;
      return ok({ path: REF.path, content: "a\n", signature: `sig-${reads}` });
    }
    bodies.push(JSON.parse(String(init?.body)));
    return new Promise<Response>((resolve) => held.push(resolve));
  }) as unknown as typeof fetch;

  /** Answer the `n`th save, counting from 0, once it has been sent. */
  async function answer(n: number, res: Response): Promise<void> {
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(n));
    held[n](res);
  }

  return { ctx: { fetcher, namespaceId: "p-1" }, bodies, answer };
}

function session() {
  const { fetcher, calls } = fetcherFor();
  return { s: new EditorSession(), ctx: { fetcher, namespaceId: "p-1" }, calls };
}

describe("EditorSession", () => {
  it("starts closed", () => {
    expect(new EditorSession().isOpen).toBe(false);
  });

  it("opens a file and holds its text", async () => {
    const { s, ctx } = session();
    await s.open(ctx, REF);

    expect(s.isOpen).toBe(true);
    expect(s.file).toEqual(REF);
    expect(s.doc?.text()).toBe("hello\n");
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("asks the file endpoint for the path it was given", async () => {
    const { s, ctx, calls } = session();
    await s.open(ctx, { ...REF, path: "src/app.ts" });
    expect(calls[0].url).toBe("/p-1/api/taskspaces/ts-1/file?path=src%2Fapp.ts");
  });

  it("reports a file it could not open, and opens nothing", async () => {
    const { fetcher } = fetcherFor({ read: [fail(413, "File is larger than 1048576 bytes")] });
    const s = new EditorSession();
    await s.open({ fetcher, namespaceId: "p-1" }, REF);

    expect(s.error).toBe("File is larger than 1048576 bytes");
    expect(s.doc).toBeNull();
    expect(s.loading).toBe(false);
  });

  it("reports a request that never arrived", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const s = new EditorSession();
    await s.open({ fetcher, namespaceId: "p-1" }, REF);
    expect(s.error).toBe("Failed to open file");
  });

  it("starts clean and goes dirty on the first edit", async () => {
    const { s, ctx } = session();
    await s.open(ctx, REF);
    expect(s.dirty).toBe(false);

    s.doc!.insert({ line: 0, column: 0 }, "x");
    expect(s.dirty).toBe(true);
  });

  it("sends the text and the signature it read on save, and comes back clean", async () => {
    const { s, ctx, calls } = session();
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 5 }, "!");

    expect(await s.save(ctx)).toBe(true);
    expect(calls[1]).toMatchObject({
      method: "PUT",
      body: { path: "notes.md", content: "hello!\n", signature: "sig-1" },
    });
    expect(s.dirty).toBe(false);
    expect(s.saving).toBe(false);
  });

  it("saves against the signature the server last reported", async () => {
    const { fetcher, calls } = fetcherFor({
      write: [ok({ signature: "sig-2" }), ok({ signature: "sig-3" })],
    });
    const s = new EditorSession();
    const ctx = { fetcher, namespaceId: "p-1" };
    await s.open(ctx, REF);

    s.doc!.insert({ line: 0, column: 0 }, "a");
    await s.save(ctx);
    s.doc!.insert({ line: 0, column: 0 }, "b");
    await s.save(ctx);

    expect(calls[1].body).toMatchObject({ signature: "sig-1" });
    expect(calls[2].body).toMatchObject({ signature: "sig-2" });
  });

  it("flags a conflict when the file changed on disk, and stays dirty", async () => {
    const { fetcher } = fetcherFor({
      write: [fail(409, "File changed on disk since it was opened")],
    });
    const s = new EditorSession();
    const ctx = { fetcher, namespaceId: "p-1" };
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 0 }, "x");

    expect(await s.save(ctx)).toBe(false);
    expect(s.conflict).toBe(true);
    expect(s.error).toBe("File changed on disk since it was opened");
    expect(s.dirty).toBe(true);
  });

  it("does not call a failure other than 409 a conflict", async () => {
    const { fetcher } = fetcherFor({ write: [fail(403, "Permission denied")] });
    const s = new EditorSession();
    const ctx = { fetcher, namespaceId: "p-1" };
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 0 }, "x");

    await s.save(ctx);
    expect(s.conflict).toBe(false);
    expect(s.error).toBe("Permission denied");
  });

  it("leaves an edit made while a save was in flight reported as unsaved", async () => {
    const { ctx, answer } = heldSaves();
    const s = new EditorSession();
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 1 }, "b");

    const saving = s.save(ctx);
    // Edits made during the request must remain dirty after the save succeeds.
    s.doc!.insert({ line: 0, column: 2 }, "c");
    await answer(0, ok({ signature: "sig-2" }));
    await saving;

    expect(s.dirty).toBe(true);
  });

  it("refuses a second save while one is in flight", async () => {
    const { s, ctx } = session();
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 0 }, "x");

    s.saving = true;
    expect(await s.save(ctx)).toBe(false);
  });

  it("lets a caller wait for the save in flight", async () => {
    const { ctx, answer } = heldSaves();
    const s = new EditorSession();
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 1 }, "b");

    void s.save(ctx);
    const settled = s.settled();
    expect(s.saving).toBe(true);
    await answer(0, ok({ signature: "sig-2" }));
    await settled;

    expect(s.saving).toBe(false);
    expect(s.dirty).toBe(false);
  });

  it("writes edits made during a save once that save lands, when asked to save again", async () => {
    const { ctx, answer, bodies } = heldSaves();
    const s = new EditorSession();
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 1 }, "b");
    const first = s.save(ctx);
    s.doc!.insert({ line: 0, column: 2 }, "c");

    const second = s.save(ctx);
    await answer(0, ok({ signature: "sig-2" }));
    await answer(1, ok({ signature: "sig-3" }));

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(bodies[1]).toMatchObject({ content: "abc\n", signature: "sig-2" });
    expect(s.dirty).toBe(false);
  });

  it("does not write again when the save it waited for failed", async () => {
    const { ctx, answer, bodies } = heldSaves();
    const s = new EditorSession();
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 1 }, "b");
    const first = s.save(ctx);
    s.doc!.insert({ line: 0, column: 2 }, "c");

    const second = s.save(ctx);
    await answer(0, fail(409, "File changed on disk"));

    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(s.conflict).toBe(true);
  });

  describe("when another file is opened while a save runs", () => {
    /** Start saving an edit to `REF`, then open and edit `other.md` before it answers. */
    async function saveThenSwitch() {
      const held = heldSaves();
      const s = new EditorSession();
      await s.open(held.ctx, REF);
      s.doc!.insert({ line: 0, column: 0 }, "x");
      const stale = s.save(held.ctx);
      await s.open(held.ctx, { ...REF, path: "other.md" });
      s.doc!.insert({ line: 0, column: 0 }, "y");
      return { s, stale, ...held };
    }

    it.each([
      ["succeeds", ok({ signature: "sig-stale" }), true],
      ["conflicts", fail(409, "File changed on disk"), false],
    ])("keeps the old save off the new file when it %s", async (_, response, written) => {
      const { s, stale, ctx, answer, bodies } = await saveThenSwitch();
      await answer(0, response);
      expect(await stale).toBe(written);

      expect(s.conflict).toBe(false);
      expect(s.error).toBeNull();
      expect(s.saving).toBe(false);

      const next = s.save(ctx);
      await answer(1, ok({ signature: "sig-3" }));
      expect(await next).toBe(true);
      expect(bodies[1]).toMatchObject({ path: "other.md", signature: "sig-2" });
    });

    it("leaves the new file's own save marked as running", async () => {
      const { s, stale, ctx, answer } = await saveThenSwitch();
      const current = s.save(ctx);

      await answer(0, ok({ signature: "sig-stale" }));
      await stale;
      expect(s.saving).toBe(true);

      await answer(1, ok({ signature: "sig-3" }));
      expect(await current).toBe(true);
      expect(s.saving).toBe(false);
    });
  });

  describe("when another file is opened while one loads", () => {
    const OTHER = { ...REF, path: "other.md" };

    /** Holds the read of REF until released, and answers OTHER at once. */
    function slowFirstRead(first: Response) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const fetcher = vi.fn(async (url: string) => {
        if (url.includes(REF.path)) {
          await held;
          return first;
        }
        return ok({ path: OTHER.path, content: "other\n", signature: "sig-other" });
      }) as unknown as typeof fetch;
      return { ctx: { fetcher, namespaceId: "p-1" }, release };
    }

    it("keeps the later file when the earlier read lands last", async () => {
      const { ctx, release } = slowFirstRead(ok({ content: "first\n", signature: "sig-first" }));
      const s = new EditorSession();
      const first = s.open(ctx, REF);
      await s.open(ctx, OTHER);
      release();
      await first;
      expect(s.file).toEqual(OTHER);
      expect(s.doc!.text()).toBe("other\n");
      expect(s.loading).toBe(false);
    });

    it("keeps the earlier read's failure off the later file", async () => {
      const { ctx, release } = slowFirstRead(fail(404, "gone"));
      const s = new EditorSession();
      const first = s.open(ctx, REF);
      await s.open(ctx, OTHER);
      release();
      await first;
      expect(s.error).toBeNull();
      expect(s.doc!.text()).toBe("other\n");
    });

    it("leaves a file closed while it loads closed", async () => {
      const { ctx, release } = slowFirstRead(ok({ content: "first\n", signature: "sig-first" }));
      const s = new EditorSession();
      const first = s.open(ctx, REF);
      s.close();
      release();
      await first;
      expect(s.isOpen).toBe(false);
      expect(s.doc).toBeNull();
    });
  });

  it("reads a file reopened during its save only after the save lands", async () => {
    const { ctx, answer, bodies } = heldSaves();
    const s = new EditorSession();
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 0 }, "x");
    void s.save(ctx);

    const reopened = s.open(ctx, REF);
    await Promise.resolve();
    expect(s.loading).toBe(true);
    expect(s.doc).toBeNull();

    await answer(0, ok({ signature: "sig-saved" }));
    await reopened;
    expect(s.loading).toBe(false);
    expect(s.doc).not.toBeNull();

    s.doc!.insert({ line: 0, column: 0 }, "y");
    const next = s.save(ctx);
    await answer(1, ok({ signature: "sig-3" }));
    expect(await next).toBe(true);
    // The read that followed the save, not the one before it.
    expect(bodies[1]).toMatchObject({ signature: "sig-2" });
  });

  it("reads a file reopened by way of another file only after its save lands", async () => {
    const { ctx, answer, bodies } = heldSaves();
    const s = new EditorSession();
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 0 }, "x");
    void s.save(ctx);
    await s.open(ctx, { ...REF, path: "other.md" });

    const reads = () =>
      vi.mocked(ctx.fetcher).mock.calls.filter(([, init]) => (init?.method ?? "GET") === "GET")
        .length;
    const reopened = s.open(ctx, REF);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.loading).toBe(true);
    expect(reads()).toBe(2);

    await answer(0, ok({ signature: "sig-saved" }));
    await reopened;
    expect(reads()).toBe(3);
    expect(s.doc).not.toBeNull();
    expect(bodies).toHaveLength(1);
  });

  it("settles at once when no save is in flight", async () => {
    const { s } = session();
    await expect(s.settled()).resolves.toBeUndefined();
  });

  it("saves nothing when nothing is open", async () => {
    const { s, ctx } = session();
    expect(await s.save(ctx)).toBe(false);
  });

  it("re-reads from disk on reload, discarding what was typed", async () => {
    const { fetcher } = fetcherFor({
      read: [
        ok({ path: REF.path, content: "before\n", signature: "sig-1" }),
        ok({ path: REF.path, content: "from disk\n", signature: "sig-9" }),
      ],
    });
    const s = new EditorSession();
    const ctx = { fetcher, namespaceId: "p-1" };
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 0 }, "typed ");

    await s.reload(ctx);
    expect(s.doc?.text()).toBe("from disk\n");
    expect(s.dirty).toBe(false);
    expect(s.conflict).toBe(false);
  });

  it("reloads nothing when nothing is open", async () => {
    const { s, ctx } = session();
    await s.reload(ctx);
    expect(s.isOpen).toBe(false);
  });

  it("forgets the file on close", async () => {
    const { s, ctx } = session();
    await s.open(ctx, REF);
    s.close();

    expect(s.isOpen).toBe(false);
    expect(s.doc).toBeNull();
    expect(s.file).toBeNull();
    expect(s.dirty).toBe(false);
  });

  it("disposes the previous document when another file is opened", async () => {
    const { fetcher } = fetcherFor({
      read: [
        ok({ path: "a.md", content: "a\n", signature: "s1" }),
        ok({ path: "b.md", content: "b\n", signature: "s2" }),
      ],
    });
    const s = new EditorSession();
    const ctx = { fetcher, namespaceId: "p-1" };
    await s.open(ctx, { ...REF, path: "a.md" });
    const first = s.doc!;
    const dispose = vi.spyOn(first, "dispose");

    await s.open(ctx, { ...REF, path: "b.md" });
    expect(dispose).toHaveBeenCalled();
    expect(s.doc).not.toBe(first);
    expect(s.doc?.text()).toBe("b\n");
  });

  describe("with an embedded static tree", () => {
    function staticCtx(staticFiles: Record<string, TaskspaceFileTree>, fetcher = fetcherFor()) {
      return {
        fetcher: fetcher.fetcher,
        ctx: { fetcher: fetcher.fetcher, namespaceId: "p-1", staticFiles },
      };
    }

    // Fall back to the live endpoint when the taskspace has no embedded tree, as in exports
    // without `--include-scoped-files`.
    it("still fetches when the context carries no static tree for this taskspace", async () => {
      const { fetcher, ctx } = staticCtx({});
      const s = new EditorSession();

      await s.open(ctx, REF);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(s.doc?.text()).toBe("hello\n");
    });

    it("opens a file's content from the embedded tree without fetching", async () => {
      const { fetcher, ctx } = staticCtx({
        [REF.taskspaceId]: {
          root: {
            kind: "directory",
            name: "",
            truncated: null,
            children: [{ kind: "file", name: REF.path, content: "from the export\n", size: 16 }],
          },
        },
      });
      const s = new EditorSession();

      await s.open(ctx, REF);

      expect(fetcher).not.toHaveBeenCalled();
      expect(s.doc?.text()).toBe("from the export\n");
      expect(s.loading).toBe(false);
      expect(s.error).toBeNull();
    });

    it("reports a skipped file's reason instead of fetching", async () => {
      const { fetcher, ctx } = staticCtx({
        [REF.taskspaceId]: {
          root: {
            kind: "directory",
            name: "",
            truncated: null,
            children: [
              { kind: "file-skipped", name: REF.path, reason: "too-large", size: 2_000_000 },
            ],
          },
        },
      });
      const s = new EditorSession();

      await s.open(ctx, REF);

      expect(fetcher).not.toHaveBeenCalled();
      expect(s.doc).toBeNull();
      expect(s.error).toBe("This file is too large to open.");
    });

    it("reports a missing path in the embedded tree without fetching", async () => {
      const { fetcher, ctx } = staticCtx({
        [REF.taskspaceId]: {
          root: { kind: "directory", name: "", truncated: null, children: [] },
        },
      });
      const s = new EditorSession();

      await s.open(ctx, REF);

      expect(fetcher).not.toHaveBeenCalled();
      expect(s.doc).toBeNull();
      expect(s.error).toBe("File not found");
    });

    it("stops loading when the embedded file waited on a save", async () => {
      const held = heldSaves();
      const s = new EditorSession();
      await s.open(held.ctx, REF);
      s.doc!.insert({ line: 0, column: 0 }, "x");
      void s.save(held.ctx);

      const reopened = s.open(
        {
          ...held.ctx,
          staticFiles: {
            [REF.taskspaceId]: {
              root: { kind: "directory", name: "", truncated: null, children: [] },
            },
          },
        },
        REF,
      );
      await held.answer(0, ok({ signature: "sig-2" }));
      await reopened;

      expect(s.loading).toBe(false);
      expect(s.error).toBe("File not found");
    });
  });

  describe("opening another file over unsaved changes", () => {
    const twoFiles = () =>
      fetcherFor({
        read: [
          ok({ path: "a.md", content: "aaa\n", signature: "s1" }),
          ok({ path: "b.md", content: "bbb\n", signature: "s2" }),
        ],
      });

    it("stays on the file when the guard declines", async () => {
      const { fetcher, calls } = twoFiles();
      const s = new EditorSession();
      const ctx = { fetcher, namespaceId: "p-1" };
      await s.open(ctx, { ...REF, path: "a.md" });
      s.doc!.insert({ line: 0, column: 0 }, "x");
      s.leaveGuard = vi.fn(async () => false);

      await s.open(ctx, { ...REF, path: "b.md" });
      expect(s.leaveGuard).toHaveBeenCalledOnce();
      expect(s.file?.path).toBe("a.md");
      expect(s.doc?.text()).toBe("xaaa\n");
      expect(calls).toHaveLength(1);
    });

    it("opens the other file when the guard agrees", async () => {
      const { fetcher } = twoFiles();
      const s = new EditorSession();
      const ctx = { fetcher, namespaceId: "p-1" };
      await s.open(ctx, { ...REF, path: "a.md" });
      s.doc!.insert({ line: 0, column: 0 }, "x");
      s.leaveGuard = async () => true;

      await s.open(ctx, { ...REF, path: "b.md" });
      expect(s.file?.path).toBe("b.md");
      expect(s.doc?.text()).toBe("bbb\n");
    });

    it("opens the file clicked last when two wait on the guard", async () => {
      const { fetcher } = fetcherFor({
        read: [
          ok({ path: "a.md", content: "aaa\n", signature: "s1" }),
          ok({ path: "c.md", content: "ccc\n", signature: "s3" }),
        ],
      });
      const s = new EditorSession();
      const ctx = { fetcher, namespaceId: "p-1" };
      await s.open(ctx, { ...REF, path: "a.md" });
      s.doc!.insert({ line: 0, column: 0 }, "x");
      const answers: ((agreed: boolean) => void)[] = [];
      s.leaveGuard = () => new Promise((resolve) => answers.push(resolve));

      const toB = s.open(ctx, { ...REF, path: "b.md" });
      const toC = s.open(ctx, { ...REF, path: "c.md" });
      answers[0](true);
      await toB;
      expect(s.file?.path).toBe("a.md");
      answers[1](true);
      await toC;
      expect(s.file?.path).toBe("c.md");
      expect(s.doc?.text()).toBe("ccc\n");
    });

    it("still opens the other file when the file was closed while the guard ran", async () => {
      const { fetcher } = twoFiles();
      const s = new EditorSession();
      const ctx = { fetcher, namespaceId: "p-1" };
      await s.open(ctx, { ...REF, path: "a.md" });
      s.doc!.insert({ line: 0, column: 0 }, "x");
      s.leaveGuard = async () => {
        s.close();
        return true;
      };

      await s.open(ctx, { ...REF, path: "b.md" });
      expect(s.file?.path).toBe("b.md");
      expect(s.doc?.text()).toBe("bbb\n");
    });

    it("does not ask when the same file is reloaded", async () => {
      const { fetcher } = fetcherFor({
        read: [
          ok({ path: REF.path, content: "a\n", signature: "s1" }),
          ok({ path: REF.path, content: "b\n", signature: "s2" }),
        ],
      });
      const s = new EditorSession();
      const ctx = { fetcher, namespaceId: "p-1" };
      await s.open(ctx, REF);
      s.doc!.insert({ line: 0, column: 0 }, "x");
      s.leaveGuard = vi.fn(async () => false);

      await s.reload(ctx);
      expect(s.leaveGuard).not.toHaveBeenCalled();
      expect(s.doc?.text()).toBe("b\n");
    });
  });

  it("puts the caret back at the start for each file opened", async () => {
    const { fetcher } = fetcherFor({
      read: [
        ok({ path: "a.md", content: "aaa\n", signature: "s1" }),
        ok({ path: "b.md", content: "bbb\n", signature: "s2" }),
      ],
    });
    const s = new EditorSession();
    const ctx = { fetcher, namespaceId: "p-1" };
    await s.open(ctx, { ...REF, path: "a.md" });
    s.caret = { line: 0, column: 3 };

    await s.open(ctx, { ...REF, path: "b.md" });
    expect(s.caret).toEqual({ line: 0, column: 0 });
    expect(s.anchor).toBeNull();
  });
});
