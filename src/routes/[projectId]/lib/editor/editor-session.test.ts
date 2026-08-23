import { describe, it, expect, vi } from "vitest";
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

function session() {
  const { fetcher, calls } = fetcherFor();
  return { s: new EditorSession(), ctx: { fetcher, projectId: "p-1" }, calls };
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
    await s.open({ fetcher, projectId: "p-1" }, REF);

    expect(s.error).toBe("File is larger than 1048576 bytes");
    expect(s.doc).toBeNull();
    expect(s.loading).toBe(false);
  });

  it("reports a request that never arrived", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const s = new EditorSession();
    await s.open({ fetcher, projectId: "p-1" }, REF);
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
    const ctx = { fetcher, projectId: "p-1" };
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
    const ctx = { fetcher, projectId: "p-1" };
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
    const ctx = { fetcher, projectId: "p-1" };
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 0 }, "x");

    await s.save(ctx);
    expect(s.conflict).toBe(false);
    expect(s.error).toBe("Permission denied");
  });

  it("leaves an edit made while a save was in flight reported as unsaved", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let call = 0;
    const fetcher = vi.fn(async () => {
      call++;
      if (call === 1) return ok({ path: REF.path, content: "a\n", signature: "sig-1" });
      await gate;
      return ok({ signature: "sig-2" });
    }) as unknown as typeof fetch;

    const s = new EditorSession();
    const ctx = { fetcher, projectId: "p-1" };
    await s.open(ctx, REF);
    s.doc!.insert({ line: 0, column: 1 }, "b");

    const saving = s.save(ctx);
    // Typed after the request went out: what was sent is already stale, so the file must
    // still count as modified once the answer arrives.
    s.doc!.insert({ line: 0, column: 2 }, "c");
    release!();
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
    const ctx = { fetcher, projectId: "p-1" };
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
    const ctx = { fetcher, projectId: "p-1" };
    await s.open(ctx, { ...REF, path: "a.md" });
    const first = s.doc!;
    const dispose = vi.spyOn(first, "dispose");

    await s.open(ctx, { ...REF, path: "b.md" });
    expect(dispose).toHaveBeenCalled();
    expect(s.doc).not.toBe(first);
    expect(s.doc?.text()).toBe("b\n");
  });

  it("puts the caret back at the start for each file opened", async () => {
    const { fetcher } = fetcherFor({
      read: [
        ok({ path: "a.md", content: "aaa\n", signature: "s1" }),
        ok({ path: "b.md", content: "bbb\n", signature: "s2" }),
      ],
    });
    const s = new EditorSession();
    const ctx = { fetcher, projectId: "p-1" };
    await s.open(ctx, { ...REF, path: "a.md" });
    s.caret = { line: 0, column: 3 };

    await s.open(ctx, { ...REF, path: "b.md" });
    expect(s.caret).toEqual({ line: 0, column: 0 });
    expect(s.anchor).toBeNull();
  });
});
