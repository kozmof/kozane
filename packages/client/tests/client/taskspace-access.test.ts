import { describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/client/http-client.js";
import { staticEditorContext } from "../../../kozane/src/test-utils/editor-context.js";

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
      const client = new HttpClient({
        fetcher,
        capabilities: { ...capabilities, writable, externalWrites },
      });
      expect(client.taskspaces!.access("n", { ...taskspace, path })).toEqual(expected);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("offers no file API when taskspaces are disabled", () => {
    const client = new HttpClient({ capabilities: { ...capabilities, taskspaces: false } });
    expect(client.taskspaces).toBeUndefined();
  });

  it("allows only embedded files belonging to the namespace", () => {
    const client = staticEditorContext(
      { t1: { root: { kind: "directory", name: "", children: [], truncated: null } } },
      "n",
    ).client;
    expect(client.taskspaces!.access("n", { ...taskspace, path: null })).toEqual({
      browse: true,
      read: true,
      write: false,
      refresh: false,
    });
    for (const [namespaceId, id] of [
      ["other", "t1"],
      ["n", "missing"],
    ]) {
      expect(client.taskspaces!.access(namespaceId, { id, path: "notes" })).toEqual({
        browse: false,
        read: false,
        write: false,
        refresh: false,
      });
    }
  });
});
