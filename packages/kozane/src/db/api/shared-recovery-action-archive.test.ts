import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { migrations } from "@kozane/core/migrations";
import {
  describeSharedRecoveryActionArchive,
  parseSharedRecoveryActionArchive,
  parseSharedRecoveryActionArchiveCheckpoint,
  requireSharedRecoveryActionArchiveCheckpoint,
  sharedRecoveryActionArchiveAssetManifest,
  describeSharedRecoveryActions,
  describeSharedRecoveryExecutions,
  describeSharedRecoveryHistory,
} from "@kozane/core/recovery";
import {
  retainedRecoveryAssetFixture,
  identity,
  manifest,
  reference,
  clone,
} from "../../test-utils/retained-recovery-assets.js";
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const f = await retainedRecoveryAssetFixture(),
    current = clone(f.originalActions.actions),
    provenance = {
      deviceId: "other-device",
      epochId: identity.epochId,
      schemaId: identity.schemaId,
      hlc: "opaque:unselected",
    };
  const generated = {
    child: { type: "child-id", value: "detached-child" },
    grand: { type: "child-id", value: "detached-grand" },
    skipped: { type: "child-id", value: "detached-skipped" },
    unused: { type: "entity-id", value: "unused" },
    clock: { type: "clock", value: -100 },
  };
  const detached = [
    {
      id: "detached",
      rootId: "detached",
      parentId: null,
      kind: "future.unselected",
      contractVersion: 77,
      input: { ref: reference(17), text: '\ufeff{"exact":true}\0🪁' },
      generated,
      seq: "3",
      ...provenance,
    },
    {
      id: "detached-child",
      rootId: "detached",
      parentId: "detached",
      kind: "future.child",
      contractVersion: 77,
      input: { ref: reference(18) },
      generated: { grand: generated.grand },
      seq: "4",
      ...provenance,
    },
    {
      id: "detached-grand",
      rootId: "detached",
      parentId: "detached-child",
      kind: "future.grand",
      contractVersion: 77,
      input: { ref: reference(19) },
      generated: {},
      seq: "5",
      ...provenance,
    },
    {
      id: "detached-skipped",
      rootId: "detached",
      parentId: "detached",
      kind: "future.skipped",
      contractVersion: 77,
      input: { ref: reference(20) },
      generated: {},
      seq: "9223372036854775807",
      ...provenance,
    },
  ];
  const actions = [...current.slice(0, 2), ...detached.slice(0, 3), current[2], detached[3]];
  return {
    checkpoint: f.binding.checkpoint.checkpoint,
    selection: { rootIds: ["root", "detached"], actionIds: actions.map((action) => action.id) },
    actions,
    originals: f.originalActions,
    executions: f.executions,
    sharedHistory: f.sharedHistory,
  };
}
function descriptor(payload: ReturnType<typeof parseSharedRecoveryActionArchive>) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    version: 1,
    checkpoint: payload.checkpoint,
    selection: payload.selection,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
it("retains additional roots, skipped descendants, exact sequences and bindings without selecting or replaying them", async () => {
  const f = await fixture(),
    before = JSON.stringify(f),
    result = await describeSharedRecoveryActionArchive(f);
  expect(result.payload.actions.map(({ seq }) => seq)).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
    "9007199254740993",
    "9223372036854775807",
  ]);
  expect(result.payload.selection.rootIds).toEqual(["root", "detached"]);
  expect(result.payload.actions[2].contractVersion).toBe(77);
  expect(result.payload.actions[2].input).toEqual({
    ref: reference(17),
    text: '\ufeff{"exact":true}\0🪁',
  });
  expect(result.payload.actions[3].generated).toEqual({
    grand: { type: "child-id", value: "detached-grand" },
  });
  expect(result.checkpoint).toEqual(descriptor(result.payload));
  expect(result.checkpoint.byteLength).toBeGreaterThan(JSON.stringify(result.payload).length);
  expect(
    await requireSharedRecoveryActionArchiveCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      f,
    ),
  ).toEqual(result.payload);
  expect(Object.isFrozen(result.payload.actions[2].generated)).toBe(true);
  expect(Object.isFrozen(result.checkpoint.selection.rootIds)).toBe(true);
  const shuffled = clone(f);
  shuffled.actions.reverse();
  expect((await describeSharedRecoveryActionArchive(shuffled)).checkpoint).toEqual(
    result.checkpoint,
  );
  expect(parseSharedRecoveryActionArchiveCheckpoint(result.checkpoint)).toEqual(result.checkpoint);
  expect(JSON.stringify(f)).toBe(before);
});
it.each([
  "missing-current-root",
  "missing-current-action",
  "missing-detached",
  "duplicate-root",
  "duplicate-action",
  "unlisted-root",
  "root-order",
  "parent",
  "cross-root",
  "binding",
  "contract",
  "epoch",
  "schema",
  "sequence",
  "sequence-limit",
  "sequence-order",
])("refuses malformed archive %s", async (change) => {
  const f = await fixture(),
    result = await describeSharedRecoveryActionArchive(f),
    payload = clone(result.payload);
  if (change === "missing-current-root") payload.selection.rootIds.shift();
  if (change === "missing-current-action") payload.selection.actionIds.shift();
  if (change === "missing-detached") payload.actions.splice(2, 1);
  if (change === "duplicate-root") payload.selection.rootIds.push("root");
  if (change === "duplicate-action") payload.actions.push(payload.actions[2]);
  if (change === "unlisted-root") payload.selection.rootIds.pop();
  if (change === "root-order") payload.selection.rootIds.reverse();
  if (change === "parent") payload.actions[4].parentId = "absent";
  if (change === "cross-root") payload.actions[4].parentId = "root";
  if (change === "binding") payload.actions[2].generated.grand.value = "changed";
  if (change === "contract") payload.actions[4].contractVersion++;
  if (change === "epoch") payload.actions[2].epochId = "other";
  if (change === "schema") payload.actions[2].schemaId = migrations.at(-2)!.id;
  if (change === "sequence") payload.actions[4].seq = "4";
  if (change === "sequence-limit") payload.actions[6].seq = "9223372036854775808";
  if (change === "sequence-order") {
    const x = payload.selection.actionIds[2];
    payload.selection.actionIds[2] = payload.selection.actionIds[3];
    payload.selection.actionIds[3] = x;
  }
  expect(() => parseSharedRecoveryActionArchive(payload)).toThrow();
});
it.each(["input", "sequence", "provenance", "provider"])(
  "refuses changed current %s records despite structurally valid archived data",
  async (change) => {
    const f = await fixture();
    if (change === "input") f.actions[0].input.text = "changed";
    if (change === "sequence") f.actions[5].seq = "9007199254740994";
    if (change === "provenance") f.actions[1].hlc = "changed";
    if (change === "provider") f.actions[0].generated.unused.value = "changed";
    expect(() =>
      parseSharedRecoveryActionArchive({
        version: 1,
        checkpoint: f.checkpoint,
        selection: f.selection,
        actions: f.actions,
      }),
    ).not.toThrow();
    await expect(describeSharedRecoveryActionArchive(f)).rejects.toThrow();
  },
);
it.each(["truncated", "input", "first-record", "allocation", "source-checkpoint"])(
  "requires exact trusted inventory and contents after %s changes",
  async (change) => {
    const f = await fixture(),
      result = await describeSharedRecoveryActionArchive(f),
      payload = clone(result.payload);
    if (change === "truncated") {
      payload.actions = payload.actions.filter((a: any) => a.rootId !== "detached");
      payload.selection.rootIds.pop();
      payload.selection.actionIds = payload.actions.map((a: any) => a.id);
    }
    if (change === "input") payload.actions[2].input.text = "changed";
    if (change === "first-record") payload.actions[2].deviceId = "changed";
    if (change === "allocation") payload.actions[2].generated.unused.value = "changed";
    if (change === "source-checkpoint") payload.checkpoint.sha256 = "b".repeat(64);
    expect(() => parseSharedRecoveryActionArchive(payload)).not.toThrow();
    await expect(
      requireSharedRecoveryActionArchiveCheckpoint(payload, result.checkpoint, identity, f),
    ).rejects.toThrow();
  },
);
it.each(["originals", "executions", "sharedHistory"] as const)(
  "requires actual current %s contents",
  async (source) => {
    const f = await fixture(),
      result = await describeSharedRecoveryActionArchive(f);
    if (source === "originals") f.originals.actions[2].input.extra = true;
    if (source === "executions") f.executions.effectSets[0].executions[1].input.extra = true;
    if (source === "sharedHistory") {
      f.sharedHistory.history.effectSets[0].effects[0].after.name = ["text", reference(21)];
      f.sharedHistory.history.effectSets[0].effects[1].before.name = ["text", reference(21)];
    }
    await expect(
      requireSharedRecoveryActionArchiveCheckpoint(result.payload, result.checkpoint, identity, f),
    ).rejects.toThrow();
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "requires expected %s before hashing",
  async (field) => {
    const f = await fixture(),
      result = await describeSharedRecoveryActionArchive(f),
      digest = vi.spyOn(crypto.subtle, "digest");
    await expect(
      requireSharedRecoveryActionArchiveCheckpoint(
        result.payload,
        result.checkpoint,
        { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        f,
      ),
    ).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);
it.each(["describe", "verify"])(
  "owns all metadata and sources before the first digest during %s",
  async (mode) => {
    const f = await fixture(),
      result = await describeSharedRecoveryActionArchive(f),
      input = clone(f),
      payload = clone(result.payload),
      checkpoint = clone(result.checkpoint),
      expected = { ...identity },
      digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      input.actions.length = 0;
      input.selection.rootIds.length = 0;
      input.originals.actions.length = 0;
      input.executions.effectSets.length = 0;
      input.sharedHistory.history.effectSets.length = 0;
      payload.actions.length = 0;
      checkpoint.sha256 = "b".repeat(64);
      expected.deviceId = "changed";
      return digest(...args);
    });
    expect(
      mode === "describe"
        ? (await describeSharedRecoveryActionArchive(input)).payload
        : await requireSharedRecoveryActionArchiveCheckpoint(payload, checkpoint, expected, input),
    ).toEqual(result.payload);
  },
);
it.each(["getter", "array-getter", "extra", "version"])(
  "refuses %s archive transport without invoking hooks",
  async (change) => {
    const f = await fixture(),
      result = await describeSharedRecoveryActionArchive(f),
      payload = clone(result.payload),
      hook = vi.fn();
    if (change === "getter")
      Object.defineProperty(payload, "actions", { enumerable: true, get: hook });
    if (change === "array-getter")
      Object.defineProperty(payload.actions, "2", { enumerable: true, get: hook });
    if (change === "extra") payload.extra = true;
    if (change === "version") payload.version++;
    expect(() => parseSharedRecoveryActionArchive(payload)).toThrow();
    expect(hook).not.toHaveBeenCalled();
  },
);
it.each(["version", "hash", "hash-newline", "length", "selection"])(
  "refuses malformed archive descriptor %s",
  async (change) => {
    const f = await fixture(),
      result = await describeSharedRecoveryActionArchive(f),
      cp = clone(result.checkpoint);
    if (change === "version") cp.version++;
    if (change === "hash") cp.sha256 = "A".repeat(64);
    if (change === "hash-newline") cp.sha256 += "\n";
    if (change === "length") cp.byteLength = 0;
    if (change === "selection") cp.selection.actionIds.shift();
    expect(() => parseSharedRecoveryActionArchiveCheckpoint(cp)).toThrow();
  },
);
it("collects all original image references from unselected roots, descendants and skipped actions", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryActionArchive(f),
    images = manifest(0, 11, 12, 17, 18, 19, 20, 21);
  expect(sharedRecoveryActionArchiveAssetManifest(result.payload, images)).toEqual(images);
  for (const n of [17, 18, 19, 20])
    expect(() =>
      sharedRecoveryActionArchiveAssetManifest(result.payload, {
        version: 1,
        entries: images.entries.filter((entry) => entry.name !== manifest(n).entries[0].name),
      }),
    ).toThrow();
});
it("verifies nested original content even when the outer archive digest is deliberately recomputed", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryActionArchive(f),
    payload = clone(result.payload);
  payload.checkpoint.sha256 = "b".repeat(64);
  const parsed = parseSharedRecoveryActionArchive(payload);
  await expect(
    requireSharedRecoveryActionArchiveCheckpoint(parsed, descriptor(parsed), identity, f),
  ).rejects.toThrow("content mismatch");
});
it("permits additional roots when the current materialization has no actions", async () => {
  const f = await fixture(),
    shared = await describeSharedRecoveryHistory(
      { baseline: f.sharedHistory.history.baseline, effectSets: [] },
      identity,
      { baselineId: "baseline", effectSets: [] },
    ),
    execution = await describeSharedRecoveryExecutions({
      checkpoint: shared.checkpoint,
      sharedHistory: shared.payload,
      selection: { baselineId: "baseline", effectSets: [] },
      effectSets: [],
    }),
    originals = await describeSharedRecoveryActions({
      checkpoint: execution.checkpoint,
      executions: execution.payload,
      sharedHistory: shared.payload,
      selection: { actionIds: [] },
      actions: [],
    });
  const actions = f.actions.filter((a: any) => a.rootId === "detached"),
    contents = {
      originals: originals.payload,
      executions: execution.payload,
      sharedHistory: shared.payload,
    };
  const result = await describeSharedRecoveryActionArchive({
    ...contents,
    checkpoint: originals.checkpoint,
    selection: { rootIds: ["detached"], actionIds: actions.map((a: any) => a.id) },
    actions,
  });
  expect(result.payload.actions).toEqual(actions);
  expect(
    await requireSharedRecoveryActionArchiveCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      contents,
    ),
  ).toEqual(result.payload);
});
it("preserves extra skipped actions of selected roots without changing their current original descriptor", async () => {
  const f = await fixture(),
    subset = await describeSharedRecoveryActions({
      checkpoint: f.originals.checkpoint,
      executions: f.executions,
      sharedHistory: f.sharedHistory,
      selection: { actionIds: ["root", "child"] },
      actions: f.originals.actions.slice(0, 2),
    });
  const result = await describeSharedRecoveryActionArchive({
    ...f,
    checkpoint: subset.checkpoint,
    originals: subset.payload,
  });
  expect(result.payload.actions.find((a) => a.id === "skipped")).toEqual(f.originals.actions[2]);
  expect(result.payload.checkpoint.selection.actionIds).toEqual(["root", "child"]);
});
it("inspects historical archive expectations without accepting old-schema action records", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryActionArchive(f),
    cp = clone(result.checkpoint);
  cp.checkpoint.checkpoint.checkpoint.identity.schemaId = migrations.at(-2)!.id;
  expect(parseSharedRecoveryActionArchiveCheckpoint(cp)).toEqual(cp);
  expect(() =>
    parseSharedRecoveryActionArchive({ ...result.payload, checkpoint: cp.checkpoint }),
  ).toThrow("Unsupported");
});
