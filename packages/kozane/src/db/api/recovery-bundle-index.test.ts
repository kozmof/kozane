import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { migrations } from "@kozane/core/migrations";
import {
  RECOVERY_BUNDLE_INDEX_VERSION,
  RECOVERY_BUNDLE_CHECKPOINT_VERSION,
  describeRunArchiveAssets,
  describeRecoveryBundleIndex,
  parseRecoveryBundleIndex,
  parseRecoveryBundleCheckpoint,
  requireRecoveryBundleCheckpoint,
  type RecoveryBundleSources,
} from "@kozane/core/recovery";
import { runArchiveAssetFixture } from "../../test-utils/run-archive-assets.js";
import { identity, clone, manifest, reference } from "../../test-utils/retained-recovery-assets.js";
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const f = await runArchiveAssetFixture(),
    assets = await describeRunArchiveAssets(f);
  const contents: RecoveryBundleSources = {
    localSnapshot: f.localSnapshot,
    sharedHistory: f.sharedHistory,
    executions: f.executions,
    originalActions: f.originalActions,
    actionArchive: f.actionArchive,
    runArchive: f.runArchive,
    currentAssets: f.currentAssets,
    runAssets: clone(assets.payload),
  };
  return { checkpoint: clone(assets.checkpoint), contents };
}
function descriptor(index: ReturnType<typeof parseRecoveryBundleIndex>) {
  const bytes = Buffer.from(JSON.stringify(index));
  return {
    version: 1,
    runAssetCheckpoint: index.runAssetCheckpoint,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
it("binds a closed eight-payload inventory and complete images to independent canonical hashes", async () => {
  const f = await fixture(),
    before = JSON.stringify(f),
    result = await describeRecoveryBundleIndex(f.checkpoint, f.contents);
  expect(result.index.version).toBe(RECOVERY_BUNDLE_INDEX_VERSION);
  expect(result.checkpoint.version).toBe(RECOVERY_BUNDLE_CHECKPOINT_VERSION);
  expect(result.checkpoint).toEqual(descriptor(result.index));
  expect(result.checkpoint.byteLength).toBeGreaterThan(JSON.stringify(result.index).length);
  expect(result.index.runAssetCheckpoint).toEqual(f.checkpoint);
  expect(result.index.payloads.map(({ kind }) => kind)).toEqual([
    "local-snapshot",
    "shared-history",
    "executions",
    "original-actions",
    "action-archive",
    "run-archive",
    "current-assets",
    "run-assets",
  ]);
  const cp = f.checkpoint,
    runs = cp.binding.checkpoint,
    archive = runs.checkpoint,
    originals = archive.checkpoint,
    executions = originals.checkpoint;
  expect(result.index.payloads.map(({ byteLength, sha256 }) => ({ byteLength, sha256 }))).toEqual(
    [
      cp.binding.localCheckpoint,
      executions.checkpoint,
      executions,
      originals,
      archive,
      runs,
      cp.assetCheckpoint,
      cp,
    ].map(({ byteLength, sha256 }) => ({ byteLength, sha256 })),
  );
  expect(result.index.manifest).toEqual(
    manifest(...Array.from({ length: 32 }, (_, n) => n).filter((n) => n !== 3)),
  );
  expect(
    await requireRecoveryBundleCheckpoint(result.index, result.checkpoint, identity, f.contents),
  ).toEqual(result.index);
  expect(JSON.stringify(f)).toBe(before);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.index.payloads[0])).toBe(true);
  expect(Object.isFrozen(result.index.manifest.entries[0])).toBe(true);
  expect(Object.isFrozen(result.checkpoint.runAssetCheckpoint.binding.localCheckpoint)).toBe(true);
});
it.each(["missing", "extra", "duplicate", "order", "kind", "hash", "length", "path"])(
  "refuses %s payload references",
  async (change) => {
    const f = await fixture(),
      result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
      input = clone(result.index);
    if (change === "missing") input.payloads.pop();
    if (change === "extra") input.payloads.push(input.payloads[0]);
    if (change === "duplicate") input.payloads[1] = input.payloads[0];
    if (change === "order") input.payloads.reverse();
    if (change === "kind") input.payloads[0].kind = "../checkpoints";
    if (change === "hash") input.payloads[0].sha256 = "b".repeat(64);
    if (change === "length") input.payloads[0].byteLength++;
    if (change === "path") input.payloads[0].path = "outside.json";
    expect(() => parseRecoveryBundleIndex(input)).toThrow();
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "requires the exact host %s",
  async (field) => {
    const f = await fixture(),
      result = await describeRecoveryBundleIndex(f.checkpoint, f.contents);
    await expect(
      requireRecoveryBundleCheckpoint(
        result.index,
        result.checkpoint,
        { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        f.contents,
      ),
    ).rejects.toThrow();
  },
);
it.each(["byteLength", "sha256", "version", "source-binding"])(
  "requires trusted expectations after %s changes",
  async (change) => {
    const f = await fixture(),
      result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
      cp = clone(result.checkpoint);
    if (change === "byteLength") cp.byteLength++;
    if (change === "sha256") cp.sha256 = "b".repeat(64);
    if (change === "version") cp.version = 2;
    if (change === "source-binding") cp.runAssetCheckpoint.sha256 = "b".repeat(64);
    await expect(
      requireRecoveryBundleCheckpoint(result.index, cp, identity, f.contents),
    ).rejects.toThrow();
  },
);
it.each([
  "localSnapshot",
  "sharedHistory",
  "executions",
  "originalActions",
  "actionArchive",
  "runArchive",
  "currentAssets",
  "runAssets",
] as const)("verifies actual %s contents", async (name) => {
  const f = await fixture(),
    result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
    input = f.contents as any;
  if (name === "localSnapshot")
    input.localSnapshot.tables.find(
      (t: any) => t.name === "local_image_upload",
    ).rows[0].created_at = ["integer", "9007199254740994"];
  if (name === "sharedHistory") {
    input.sharedHistory.history.effectSets[0].effects[0].after.name = ["text", reference(32)];
    input.sharedHistory.history.effectSets[0].effects[1].before.name = ["text", reference(32)];
  }
  if (name === "executions") input.executions.effectSets[0].executions[1].input.text = "changed";
  if (name === "originalActions") input.originalActions.actions[2].input.text = "changed";
  if (name === "actionArchive") input.actionArchive.actions[2].hlc = "changed";
  if (name === "runArchive")
    input.runArchive.effectSets[5].executions.effectSets[0].executions[1].input.text = "changed";
  if (name === "currentAssets") input.currentAssets.manifest.entries[0].sha256 = "b".repeat(64);
  if (name === "runAssets") {
    input.runAssets.originalImages.entries.push(manifest(33).entries[0]);
    input.runAssets.manifest.entries.push(manifest(33).entries[0]);
  }
  await expect(describeRecoveryBundleIndex(f.checkpoint, f.contents)).rejects.toThrow();
  await expect(
    requireRecoveryBundleCheckpoint(result.index, result.checkpoint, identity, f.contents),
  ).rejects.toThrow();
});
it.each(["missing", "extra", "identity"])(
  "refuses %s image requirements even with a matching index hash",
  async (change) => {
    const f = await fixture(),
      result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
      input = clone(result.index);
    if (change === "missing") input.manifest.entries.pop();
    if (change === "extra") input.manifest.entries.push(manifest(33).entries[0]);
    if (change === "identity") input.manifest.entries[0].byteLength++;
    const parsed = parseRecoveryBundleIndex(input);
    await expect(
      requireRecoveryBundleCheckpoint(parsed, descriptor(parsed), identity, f.contents),
    ).rejects.toThrow("image requirements");
  },
);
it.each(["baseline", "never-executed"])(
  "requires independent %s coverage despite recomputed manifest hashes",
  async (gap) => {
    const f = await fixture(),
      payload = f.contents.runAssets as any;
    if (gap === "baseline") payload.history.effectSets[0].history.baseline.manifest.entries = [];
    else
      payload.originalImages.entries = payload.originalImages.entries.filter(
        (e: any) => e.name !== manifest(31).entries[0].name,
      );
    const bytes = Buffer.from(JSON.stringify(payload));
    f.checkpoint.byteLength = bytes.length;
    f.checkpoint.sha256 = createHash("sha256").update(bytes).digest("hex");
    await expect(describeRecoveryBundleIndex(f.checkpoint, f.contents)).rejects.toThrow();
  },
);
it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "refuses malformed byte length %s",
  async (length) => {
    const f = await fixture(),
      result = await describeRecoveryBundleIndex(f.checkpoint, f.contents);
    expect(() =>
      parseRecoveryBundleCheckpoint({ ...result.checkpoint, byteLength: length }),
    ).toThrow();
    const input = clone(result.index);
    input.payloads[0].byteLength = length;
    expect(() => parseRecoveryBundleIndex(input)).toThrow();
  },
);
it.each(["A".repeat(64), "a".repeat(63), "a".repeat(64) + "\n", 42, null])(
  "refuses malformed checkpoint hash %s",
  async (sha256) => {
    const f = await fixture(),
      result = await describeRecoveryBundleIndex(f.checkpoint, f.contents);
    expect(() => parseRecoveryBundleCheckpoint({ ...result.checkpoint, sha256 })).toThrow();
  },
);
it("owns all eight sources, expectations and identity before the first hash yields", async () => {
  const f = await fixture(),
    result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
    expected = clone(identity),
    cp = clone(result.checkpoint),
    input = clone(result.index);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce((algorithm, data) => {
    input.manifest.entries.length = 0;
    cp.sha256 = "b".repeat(64);
    expected.deviceId = "changed";
    for (const name of Object.keys(f.contents)) (f.contents as any)[name] = {};
    return digest(algorithm, data);
  });
  expect(await requireRecoveryBundleCheckpoint(input, cp, expected, f.contents)).toEqual(
    result.index,
  );
});
it("owns all eight sources before preparation hashing yields", async () => {
  const f = await fixture(),
    result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce((algorithm, data) => {
    f.checkpoint.sha256 = "b".repeat(64);
    for (const name of Object.keys(f.contents)) (f.contents as any)[name] = {};
    return digest(algorithm, data);
  });
  expect(await describeRecoveryBundleIndex(f.checkpoint, f.contents)).toEqual(result);
});
it("canonicalizes image entry order without changing fixed payload roles", async () => {
  const f = await fixture(),
    result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
    input = clone(result.index);
  input.manifest.entries.reverse();
  expect(parseRecoveryBundleIndex(input)).toEqual(result.index);
  expect(
    await requireRecoveryBundleCheckpoint(input, result.checkpoint, identity, f.contents),
  ).toEqual(result.index);
});
it("keeps known historical metadata inspectable without authorizing current source verification", async () => {
  const f = await fixture(),
    result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
    input = clone(result.index);
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if ("schemaId" in value) value.schemaId = migrations.at(-2)!.id;
    for (const child of Object.values(value)) visit(child);
  };
  visit(input.runAssetCheckpoint);
  const parsed = parseRecoveryBundleIndex(input),
    cp = parseRecoveryBundleCheckpoint(descriptor(parsed));
  expect(cp.runAssetCheckpoint.binding.localCheckpoint.identity.schemaId).toBe(
    migrations.at(-2)!.id,
  );
  await expect(
    describeRecoveryBundleIndex(parsed.runAssetCheckpoint, f.contents),
  ).rejects.toThrow();
  await expect(requireRecoveryBundleCheckpoint(parsed, cp, identity, f.contents)).rejects.toThrow();
});
it.each(["index", "checkpoint", "sources"])(
  "refuses %s accessors without invoking them",
  async (target) => {
    const f = await fixture(),
      result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
      read = vi.fn(() => {
        throw Error("Accessor invoked");
      });
    if (target === "index") {
      const value = clone(result.index);
      Object.defineProperty(value, "payloads", { enumerable: true, get: read });
      expect(() => parseRecoveryBundleIndex(value)).toThrow();
    } else if (target === "checkpoint") {
      const value = clone(result.checkpoint);
      Object.defineProperty(value, "sha256", { enumerable: true, get: read });
      expect(() => parseRecoveryBundleCheckpoint(value)).toThrow();
    } else {
      Object.defineProperty(f.contents, "runAssets", { enumerable: true, get: read });
      await expect(describeRecoveryBundleIndex(f.checkpoint, f.contents)).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled();
  },
);
it.each(["missing", "extra", "sparse", "hook"])(
  "refuses malformed %s inventory data",
  async (change) => {
    const f = await fixture(),
      result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
      input = clone(result.index);
    if (change === "missing") delete input.manifest;
    if (change === "extra") input.extra = true;
    if (change === "sparse") delete input.payloads[2];
    if (change === "hook") input.toJSON = () => result.index;
    expect(() => parseRecoveryBundleIndex(input)).toThrow();
  },
);

it.each([
  "localSnapshot",
  "sharedHistory",
  "executions",
  "originalActions",
  "actionArchive",
  "runArchive",
  "currentAssets",
  "runAssets",
] as const)("refuses missing %s before hashing", async (name) => {
  const f = await fixture(),
    result = await describeRecoveryBundleIndex(f.checkpoint, f.contents),
    input = { ...f.contents };
  delete (input as any)[name];
  const digest = vi.spyOn(crypto.subtle, "digest");
  await expect(describeRecoveryBundleIndex(f.checkpoint, input)).rejects.toThrow();
  await expect(
    requireRecoveryBundleCheckpoint(result.index, result.checkpoint, identity, input),
  ).rejects.toThrow();
  expect(digest).not.toHaveBeenCalled();
});
