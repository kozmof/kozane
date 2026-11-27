import { describe, expect, it, vi } from "vitest";
import { createActionBindings } from "../../../core/src/actions/bindings.js";
import { actionContractsV1, type ActionKindV1 } from "../../../core/src/actions/contracts.js";
import { prepareActionInputV1 } from "../../../core/src/actions/invocation.js";
import {
  ActionContractRequiredError,
  createActionRegistryCatalog,
  createActionRegistryV1,
  defineActionRegistry,
  type ActionDefinitions,
  type ActionHandlersV1,
} from "../../../core/src/actions/registry.js";

function execution() {
  return {
    context: { writes: [] as unknown[] },
    bindings: createActionBindings({ mode: "replay", bindings: {} }),
  };
}
function v1Handlers() {
  return Object.fromEntries(
    Object.entries(actionContractsV1).map(([kind, eligibility]) => [
      kind,
      eligibility === "syncable"
        ? { replay: vi.fn(async () => kind) }
        : { recover: vi.fn(async () => kind) },
    ]),
  ) as unknown as ActionHandlersV1<{ writes: unknown[] }>;
}

describe("versioned action registry", () => {
  type Inputs = { edit: { value: number } };
  function version(contractVersion: number, schemaVersions: number[]) {
    const replay = vi.fn(async (input: Inputs["edit"]) => ({
      contractVersion,
      value: input.value,
    }));
    const registry = defineActionRegistry<Inputs, { writes: unknown[] }>({
      contractVersion,
      schemaVersions,
      definitions: {
        edit: { eligibility: "syncable", prepare: (input) => input as Inputs["edit"], replay },
      },
    });
    return { registry, replay };
  }

  it("dispatches the recorded version instead of the latest handler", async () => {
    const old = version(1, [19, 20]);
    const current = version(2, [20]);
    const catalog = createActionRegistryCatalog([old.registry, current.registry]);
    const selected = catalog.select(1, 20);
    expect(await selected.replay("edit", { value: 7 }, execution())).toEqual({
      contractVersion: 1,
      value: 7,
    });
    expect(old.replay).toHaveBeenCalledOnce();
    expect(current.replay).not.toHaveBeenCalled();
  });

  it("reports compatible versions without invoking handlers, including an empty compatibility set", () => {
    const old = version(1, [19]);
    const current = version(2, [20]);
    const catalog = createActionRegistryCatalog([current.registry, old.registry]);
    for (const [requestedVersion, schemaVersion, supportedVersions] of [
      [1, 20, [2]],
      [3, 19, [1]],
      [1, 99, []],
    ] as const) {
      expect(() => catalog.select(requestedVersion, schemaVersion)).toThrow(
        ActionContractRequiredError,
      );
      try {
        catalog.select(requestedVersion, schemaVersion);
      } catch (error) {
        expect(error).toMatchObject({
          code: "action-contract-required",
          requestedVersion,
          schemaVersion,
          supportedVersions,
        });
      }
    }
    expect(old.replay).not.toHaveBeenCalled();
    expect(current.replay).not.toHaveBeenCalled();
  });

  it("does not let caller mutation replace registered handlers or schema support", async () => {
    const schemas = [19];
    const replay = vi.fn(async () => "original");
    const replacement = vi.fn(async () => "replacement");
    const definition = {
      eligibility: "syncable" as const,
      prepare: (input: unknown) => input as Inputs["edit"],
      replay,
    };
    const registry = defineActionRegistry<Inputs, { writes: unknown[] }>({
      contractVersion: 1,
      schemaVersions: schemas,
      definitions: { edit: definition },
    });
    schemas.push(20);
    definition.replay = replacement;
    expect(registry.supportsSchema(20)).toBe(false);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(await registry.replay("edit", { value: 1 }, execution())).toBe("original");
    expect(replacement).not.toHaveBeenCalled();
  });

  it("checks eligibility against copied definitions without preparing input or invoking handlers", () => {
    const prepare = vi.fn((input: unknown) => input);
    const handler = vi.fn(async () => "not called");
    const definitions: ActionDefinitions<{ edit: unknown; file: unknown }, unknown> = {
      edit: { eligibility: "syncable", prepare, replay: handler },
      file: { eligibility: "local-only", prepare, recover: handler },
    };
    const registry = defineActionRegistry({
      contractVersion: 1,
      schemaVersions: [19],
      definitions,
    });
    Reflect.set(definitions.edit, "eligibility", "local-only");
    Reflect.set(definitions.file, "eligibility", "syncable");
    expect(() => registry.assertSyncable("edit")).not.toThrow();
    expect(() => registry.assertSyncable("file")).toThrow("Action is local-only: file");
    expect(() => registry.assertSyncable("__proto__")).toThrow("Unknown action kind: __proto__");
    expect(prepare).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses duplicate versions and invalid version declarations", () => {
    const f = version(1, [19]);
    expect(() => createActionRegistryCatalog([f.registry, f.registry])).toThrow(
      "Duplicate action contract",
    );
    for (const [contract, schemas] of [
      [0, [19]],
      [1.5, [19]],
      [1, []],
      [1, [-1]],
      [1, [NaN]],
    ] as [number, number[]][])
      expect(() => version(contract, schemas)).toThrow(TypeError);
  });

  it("requires every version 1 handler with the declared replay or recovery role", () => {
    const handlers = v1Handlers();
    expect(() => createActionRegistryV1([19], handlers)).not.toThrow();
    Reflect.deleteProperty(handlers, "cards.update");
    expect(() => createActionRegistryV1([19], handlers)).toThrow(
      "Missing action handler: cards.update",
    );
    const wrongRole = { ...v1Handlers(), "cards.update": { recover: vi.fn() } };
    expect(() =>
      createActionRegistryV1([19], wrongRole as unknown as ReturnType<typeof v1Handlers>),
    ).toThrow("Missing action handler: cards.update");
    const extra = { ...v1Handlers(), unexpected: { replay: vi.fn() } };
    expect(() => createActionRegistryV1([19], extra)).toThrow("Unknown version 1 action handler");
  });

  it("keeps local file recovery explicit and never retries a failed callback", async () => {
    const handlers = v1Handlers();
    const registry = createActionRegistryV1([19], handlers);
    const request = {
      args: { namespaceId: "n", taskspaceId: "t" },
      body: { path: "a.md", content: "text", signature: null },
    };
    await expect(registry.replay("taskspaces.saveFile", request, execution())).rejects.toThrow(
      "local-only",
    );
    expect(handlers["taskspaces.saveFile"].recover).not.toHaveBeenCalled();
    expect(await registry.recover("taskspaces.saveFile", request, execution())).toBe(
      "taskspaces.saveFile",
    );
    const failure = new Error("disk failure");
    vi.mocked(handlers["taskspaces.saveFile"].recover).mockRejectedValueOnce(failure);
    await expect(registry.recover("taskspaces.saveFile", request, execution())).rejects.toBe(
      failure,
    );
    expect(handlers["taskspaces.saveFile"].recover).toHaveBeenCalledTimes(2);
    await expect(
      registry.recover(
        "cards.update",
        { args: { namespaceId: "n", cardId: "c" }, body: {} },
        execution(),
      ),
    ).rejects.toThrow("no file recovery handler");
  });

  it("copies input before preparation and dispatch and does not normalize domain fields", async () => {
    const handlers = v1Handlers();
    const input = {
      args: { namespaceId: "n", cardId: "c" },
      body: { content: "original", posX: 1.25, width: null },
    };
    const registry = createActionRegistryV1([19], handlers);
    const dispatched = registry.replay("cards.update", input, execution());
    input.body.content = "changed";
    await dispatched;
    const prepared = vi.mocked(handlers["cards.update"].replay).mock.calls[0][0];
    expect(prepared).toEqual({
      args: { namespaceId: "n", cardId: "c" },
      body: { content: "original", posX: 1.25, width: null },
    });
    expect(prepared.args).not.toBe(input.args);
    expect(prepared.body).not.toBe(input.body);
  });

  it("refuses invalid routes and unsafe input before a handler runs", async () => {
    const handlers = v1Handlers();
    const registry = createActionRegistryV1([19], handlers);
    await expect(
      registry.replay(
        "cards.update",
        { args: { namespaceId: "n" }, body: { content: "text" } },
        execution(),
      ),
    ).rejects.toThrow("routing arguments");
    const getter = vi.fn(() => "n");
    await expect(
      registry.replay(
        "cards.update",
        {
          args: {
            get namespaceId() {
              return getter();
            },
            cardId: "c",
          },
          body: {},
        },
        execution(),
      ),
    ).rejects.toThrow("JSON-compatible");
    await expect(registry.replay("__proto__" as ActionKindV1, {}, execution())).rejects.toThrow(
      "Unknown action kind",
    );
    expect(getter).not.toHaveBeenCalled();
    expect(handlers["cards.update"].replay).not.toHaveBeenCalled();
  });

  it("refuses recording providers during intent replay before running a handler", async () => {
    const handlers = v1Handlers();
    const registry = createActionRegistryV1([19], handlers);
    const allocateId = vi.fn(() => "fresh-id");
    const now = vi.fn(() => 100);
    const bindings = createActionBindings({ mode: "record", allocateId, now });
    await expect(
      registry.replay(
        "cards.create",
        { args: { namespaceId: "n" }, body: { partitionId: "p", content: "text" } },
        { ...execution(), bindings },
      ),
    ).rejects.toThrow("Intent replay requires recorded bindings");
    expect(handlers["cards.create"].replay).not.toHaveBeenCalled();
    expect(allocateId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it("does not extend replay bindings when a handler takes a changed allocation branch", async () => {
    const handlers = v1Handlers();
    vi.mocked(handlers["cards.create"].replay).mockImplementation(async (_input, scope) =>
      scope.bindings.entityId("new-branch"),
    );
    const registry = createActionRegistryV1([19], handlers);
    const scope = execution();
    await expect(
      registry.replay(
        "cards.create",
        { args: { namespaceId: "n" }, body: { partitionId: "p", content: "text" } },
        scope,
      ),
    ).rejects.toThrow("Unbound replay allocation");
    expect(scope.bindings.snapshot()).toEqual({});
  });

  it("rejects missing definitions' prepare functions and handlers", () => {
    for (const definition of [
      { eligibility: "syncable", replay: async () => {} },
      { eligibility: "other", prepare: (x: unknown) => x },
    ]) {
      expect(() =>
        defineActionRegistry<Inputs, unknown>({
          contractVersion: 1,
          schemaVersions: [19],
          definitions: { edit: definition } as unknown as ActionDefinitions<Inputs, unknown>,
        }),
      ).toThrow("Invalid action definition");
    }
  });

  it.each([" ", "kind\0name", "bad\ud800", "bad\udc00", "x".repeat(1001)])(
    "refuses action kinds that recovery cannot retain: %j",
    (kind) => {
      expect(() =>
        defineActionRegistry<Record<string, unknown>, unknown>({
          contractVersion: 1,
          schemaVersions: [19],
          definitions: {
            [kind]: { eligibility: "syncable", prepare: (input) => input, replay: async () => {} },
          },
        }),
      ).toThrow("Invalid action definition");
    },
  );
});

describe("version 1 invocation envelopes", () => {
  it.each([
    ["cards.update", { args: { namespaceId: "n" }, body: {} }],
    ["cards.update", { args: { namespaceId: "n", cardId: 1 }, body: {} }],
    ["cards.update", { args: { namespaceId: "n", cardId: "c", extra: "x" }, body: {} }],
    ["scopes.updateArea", { args: { namespaceId: "n", scopeId: "s" }, body: {} }],
    ["taskspaces.removeEntry", { args: { namespaceId: "n", taskspaceId: "t" } }],
    ["cards.update", { args: { namespaceId: "n", cardId: "c" } }],
    ["cards.removeOne", { args: { namespaceId: "n", cardId: "c" }, body: {} }],
    ["namespaces.create", { args: { namespaceId: "n" }, body: { name: "name" } }],
    ["cards.update", { args: [], body: {} }],
    ["cards.update", { args: null, body: {} }],
    ["cards.update", null],
    ["cards.update", { args: { namespaceId: "n", cardId: "c" }, body: {}, keepalive: true }],
  ] as [ActionKindV1, unknown][])(
    "refuses incomplete or extra envelope fields for %s",
    (kind, input) => {
      expect(() => prepareActionInputV1(kind, input)).toThrow();
    },
  );

  it("preserves global scope creation routing and all area and file target arguments", () => {
    for (const [kind, input] of [
      ["scopes.create", { args: { namespaceId: "n" }, body: { name: "scope" } }],
      [
        "scopes.updateArea",
        { args: { namespaceId: "n", scopeId: "s", areaId: "a" }, body: { posX: -1.5 } },
      ],
      [
        "taskspaces.removeEntry",
        { args: { namespaceId: "n", taskspaceId: "t", path: "sub/file.md" } },
      ],
      ["namespaces.create", { args: {}, body: { name: " new name " } }],
    ] as [ActionKindV1, unknown][])
      expect(prepareActionInputV1(kind, input)).toEqual(input);
  });
});
