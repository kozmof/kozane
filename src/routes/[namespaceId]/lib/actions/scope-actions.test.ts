import { describe, expect, it } from "vitest";
import { createScopeActions } from "./scope-actions.js";

/** Just enough board state for requests that never get an answer. */
function offlineState() {
  return {
    namespaceId: "namespace-1",
    mutationFetcher: async () => {
      throw new TypeError("Failed to fetch");
    },
  } as never;
}

describe("scope actions used by the file browser", () => {
  it("answer a reason instead of throwing when the network is down", async () => {
    const actions = createScopeActions(offlineState());

    expect(await actions.createScope("Notes")).toEqual({ error: "Failed to create scope" });
    expect(await actions.renameScope("s1", "Notes")).toEqual({ error: "Failed to rename scope" });
    expect(await actions.removeScope("s1")).toEqual({ error: "Failed to delete scope" });
    expect(await actions.createTaskspace("s1", "draft")).toEqual({
      error: "Failed to create taskspace",
    });
    expect(await actions.renameTaskspace("t1", "final")).toEqual({
      error: "Failed to rename taskspace",
    });
    expect(await actions.deleteTaskspace("t1")).toEqual({ error: "Failed to delete taskspace" });
  });
});
