import { describe, expect, it, vi } from "vitest";
import { HttpBackend } from "./http-backend.js";
import { staticEditorContext } from "../../test-utils/editor-context.js";

const taskspace = { id: "t1", path: "notes" };
const capabilities = {
  writable: true,
  taskspaces: true,
  persistent: true,
  externalWrites: true,
  auth: false,
};

describe("taskspace file availability", () => {
  it.each([
    [true, true, "notes", { browse: true, read: true, write: true, refresh: true }],
    [true, false, "notes", { browse: true, read: true, write: true, refresh: false }],
    [false, true, "notes", { browse: true, read: false, write: false, refresh: false }],
    [true, true, null, { browse: false, read: false, write: false, refresh: false }],
  ] as const)(
    "resolves HTTP policy without requests (%s, %s, %s)",
    (writable, externalWrites, path, expected) => {
      const fetcher = vi.fn<typeof fetch>();
      const backend = new HttpBackend({
        fetcher,
        capabilities: { ...capabilities, writable, externalWrites },
      });
      expect(backend.taskspaces!.access("n", { ...taskspace, path })).toEqual(expected);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("offers no file API when taskspaces are disabled", () => {
    const backend = new HttpBackend({ capabilities: { ...capabilities, taskspaces: false } });
    expect(backend.taskspaces).toBeUndefined();
  });

  it("allows only embedded files belonging to the namespace", () => {
    const backend = staticEditorContext(
      { t1: { root: { kind: "directory", name: "", children: [], truncated: null } } },
      "n",
    ).backend;
    expect(backend.taskspaces!.access("n", { ...taskspace, path: null })).toEqual({
      browse: true,
      read: true,
      write: false,
      refresh: false,
    });
    for (const [namespaceId, id] of [
      ["other", "t1"],
      ["n", "missing"],
    ]) {
      expect(backend.taskspaces!.access(namespaceId, { id, path: "notes" })).toEqual({
        browse: false,
        read: false,
        write: false,
        refresh: false,
      });
    }
  });
});
