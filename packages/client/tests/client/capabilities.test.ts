import { describe, expect, it, vi } from "vitest";
import { createClientFeatures, assertTaskspaceSupport } from "../../src/client/capabilities.js";
import type { TaskspacesApi } from "../../src/client/taskspaces-api.js";
import { clientContractCases } from "../../src/client/testing/suite.js";
import type { KozaneClient } from "../../src/client/contract.js";

const capabilities = { writable: false, persistent: true, externalWrites: false, auth: false };
function api() {
  return Object.fromEntries(
    [
      "access",
      "create",
      "rename",
      "remove",
      "createFile",
      "readFile",
      "saveFile",
      "list",
      "createDirectory",
      "renameEntry",
      "removeEntry",
    ].map((name) => [name, vi.fn()]),
  ) as unknown as TaskspacesApi;
}
describe("client feature construction", () => {
  it("derives availability even when an input object carries an obsolete flag", () => {
    const taskspaces = api();
    const enabled = createClientFeatures(
      { ...capabilities, taskspaces: false } as typeof capabilities,
      taskspaces,
    );
    expect(enabled.capabilities.taskspaces).toBe(true);
    expect(enabled.taskspaces).toBe(taskspaces);
    expect(Object.isFrozen(enabled)).toBe(true);
    expect(Object.isFrozen(enabled.capabilities)).toBe(true);
    assertTaskspaceSupport(enabled);
    expect(taskspaces.access).not.toHaveBeenCalled();
    const disabled = createClientFeatures({
      ...capabilities,
      taskspaces: true,
    } as typeof capabilities);
    expect(disabled.capabilities.taskspaces).toBe(false);
    expect(disabled.taskspaces).toBeUndefined();
    assertTaskspaceSupport(disabled);
  });
  it("rejects incomplete APIs without calling them", () => {
    const taskspaces = api();
    delete (taskspaces as Partial<TaskspacesApi>).readFile;
    expect(() => createClientFeatures(capabilities, taskspaces)).toThrow("requires readFile");
  });
  it.each([true, false])("cleans up contradictory custom clients (flag %s)", async (flag) => {
    const cleanup = vi.fn();
    const client = {
      capabilities: { ...capabilities, taskspaces: flag },
      taskspaces: flag ? undefined : api(),
      state: { status: "ready" },
    } as unknown as KozaneClient;
    const test = clientContractCases(() => ({ client, namespaceId: "test", cleanup }))[0];
    await expect(test.run()).rejects.toThrow("Taskspace capability/API mismatch");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
