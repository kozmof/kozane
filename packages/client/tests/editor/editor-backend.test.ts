import { expect, it, vi } from "vitest";
import { HttpBackend } from "../../src/backend/http-backend.js";
import { EditorSession } from "../../src/editor/editor-session.svelte.js";
it("forwards read cancellation and preserves signatures and dirty text on backend conflicts", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('{"path":"notes.md","content":"hello","signature":"original"}'),
    )
    .mockResolvedValueOnce(
      new Response('{"message":"Changed on disk"}', {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
  const backend = new HttpBackend({
    fetcher,
    capabilities: {
      writable: true,
      persistent: true,
      taskspaces: true,
      externalWrites: false,
      auth: false,
    },
  });
  const ctx = { backend, fetcher, namespaceId: "ns" };
  const editor = new EditorSession();
  try {
    await editor.open(ctx, { taskspaceId: "ts", taskspaceName: "Directory", path: "notes.md" });
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    editor.doc!.insert({ line: 0, column: 0 }, "edited ");
    expect(await editor.save(ctx, { keepalive: true })).toBe(false);
    expect(editor.conflict).toBe(true);
    expect(editor.error).toBe("Changed on disk");
    expect(editor.dirty).toBe(true);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({
      path: "notes.md",
      content: "edited hello",
      signature: "original",
    });
    expect(fetcher.mock.calls[1][1].keepalive).toBe(true);
  } finally {
    editor.close();
  }
});
