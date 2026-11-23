import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { migrations } from "@kozane/core/migrations";
import {
  describeLocalRecoverySnapshot,
  describeSharedRecoveryHistory,
  describeSharedRecoveryExecutions,
  describeSharedRecoveryActions,
  describeSharedRecoveryActionArchive,
  describeSharedRecoveryRunArchive,
  describeRecoveryAssets,
  describeRunArchiveAssets,
  describeRetainedRecoveryAssets,
  parseRetainedRecoveryAssetPayload,
  parseRunArchiveAssetPayload,
  parseRunArchiveAssetCheckpoint,
  requireRunArchiveAssetCheckpoint,
  parseSharedRecoveryRetainedImages,
  type RunArchiveAssetSources,
} from "@kozane/core/recovery";
import { runArchiveAssetFixture as fixture } from "../../test-utils/run-archive-assets.js";
import {
  retainedRecoveryAssetFixture,
  identity,
  reference,
  manifest,
  clone,
} from "../../test-utils/retained-recovery-assets.js";
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function descriptor(payload: ReturnType<typeof parseRunArchiveAssetPayload>) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    version: 1,
    binding: payload.binding,
    assetCheckpoint: payload.assetCheckpoint,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
it("binds per-run contexts, original inputs and exact current assets to an independently hashed descriptor", async () => {
  const f = await fixture(),
    before = JSON.stringify(f),
    result = await describeRunArchiveAssets(f);
  expect(result.payload.manifest).toEqual(
    manifest(...Array.from({ length: 32 }, (_, n) => n).filter((n) => n !== 3)),
  );
  expect(result.payload.history).toEqual(parseSharedRecoveryRetainedImages(f.history));
  expect(result.payload.originalImages).toEqual(f.originalImages);
  expect(result.checkpoint).toEqual(descriptor(result.payload));
  expect(result.checkpoint.byteLength).toBeGreaterThan(JSON.stringify(result.payload).length);
  expect(
    await requireRunArchiveAssetCheckpoint(result.payload, result.checkpoint, identity, f),
  ).toEqual(result.payload);
  expect(parseRunArchiveAssetCheckpoint(result.checkpoint)).toEqual(result.checkpoint);
  expect(parseSharedRecoveryRetainedImages(f.history)).toEqual(result.payload.history);
  expect(
    Object.isFrozen(result.payload.history.effectSets[0].history.effectSets[0].manifest.entries[0]),
  ).toBe(true);
  expect(Object.isFrozen(result.payload.originalImages.entries)).toBe(true);
  expect(Object.isFrozen(result.checkpoint.binding.checkpoint.selection.effectSets)).toBe(true);
  expect(JSON.stringify(f)).toBe(before);
});
it.each([
  "baseline",
  "intermediate",
  "origin-input",
  "superseded-input",
  "original-child",
  "skipped-original",
  "original-root",
  "selected-input",
  "noop-input",
])(
  "refuses missing %s coverage even if the combined manifest can cover it elsewhere",
  async (gap) => {
    const f = await fixture();
    const remove = (m: any, n: number) => {
      const index = m.entries.findIndex((entry: any) => entry.name === manifest(n).entries[0].name);
      expect(index).toBeGreaterThanOrEqual(0);
      return m.entries.splice(index, 1)[0];
    };
    if (gap === "baseline")
      f.history.effectSets[5].history.baseline.manifest.entries.push(
        remove(f.history.effectSets[0].history.baseline.manifest, 4),
      );
    if (gap === "intermediate")
      f.history.effectSets[5].history.effectSets[0].manifest.entries.push(
        remove(f.history.effectSets[0].history.effectSets[0].manifest, 5),
      );
    if (gap === "origin-input")
      f.history.effectSets[5].history.effectSets[0].manifest.entries.push(
        remove(f.history.effectSets[0].history.effectSets[0].manifest, 9),
      );
    if (gap === "superseded-input")
      f.history.effectSets[0].history.effectSets[0].manifest.entries.push(
        remove(f.history.effectSets[5].history.effectSets[0].manifest, 8),
      );
    if (gap.startsWith("original-") || gap === "skipped-original")
      f.history.effectSets[0].history.effectSets[0].manifest.entries.push(
        remove(
          f.originalImages,
          gap === "original-child" ? 11 : gap === "skipped-original" ? 12 : 0,
        ),
      );
    if (gap === "selected-input" || gap === "noop-input") {
      const entry = remove(
        f.currentAssets.history.effectSets[gap === "selected-input" ? 0 : 1].manifest,
        gap === "selected-input" ? 10 : 0,
      );
      f.currentAssets.history.baseline.manifest.entries.push(entry);
      f.assetCheckpoint = {
        version: 1,
        binding: f.currentAssets.binding,
        byteLength: Buffer.byteLength(JSON.stringify(f.currentAssets)),
        sha256: createHash("sha256").update(JSON.stringify(f.currentAssets)).digest("hex"),
      };
    }
    await expect(describeRunArchiveAssets(f)).rejects.toThrow();
  },
);
it.each(["missing", "order", "baseline", "extra-set", "wrong-set", "duplicate"])(
  "refuses %s per-run manifest metadata",
  async (change) => {
    const f = await fixture();
    if (change === "missing") f.history.effectSets.pop();
    if (change === "order") f.history.effectSets.reverse();
    if (change === "baseline") f.history.effectSets[0].history.baseline.id = "other";
    if (change === "extra-set")
      f.history.effectSets[0].history.effectSets.push(
        f.history.effectSets[0].history.effectSets[0],
      );
    if (change === "wrong-set") f.history.effectSets[0].history.effectSets[0].id = "other";
    if (change === "duplicate") f.history.effectSets[1] = f.history.effectSets[0];
    await expect(describeRunArchiveAssets(f)).rejects.toThrow("selection mismatch");
  },
);
it.each(["per-run", "original", "current"])(
  "refuses conflicting immutable image identities in %s manifests",
  async (change) => {
    const f = await fixture();
    const target =
      change === "per-run"
        ? f.history.effectSets[0].history.effectSets[0].manifest
        : change === "original"
          ? f.originalImages
          : f.currentAssets.manifest;
    const entry = clone(manifest(0).entries[0]);
    entry.byteLength = 4;
    if (change === "original") target.entries[0] = entry;
    else if (change === "current") {
      target.entries.find((e: any) => e.name === entry.name).byteLength = 4;
      f.currentAssets.history.effectSets[0].manifest.entries.find(
        (e: any) => e.name === entry.name,
      ).byteLength = 4;
      f.currentAssets.history.effectSets[1].manifest.entries.find(
        (e: any) => e.name === entry.name,
      ).byteLength = 4;
    } else target.entries.find((e: any) => e.name === entry.name).byteLength = 4;
    await expect(describeRunArchiveAssets(f)).rejects.toThrow();
  },
);
it.each([
  "manifest",
  "original-images",
  "per-run",
  "provenance",
  "current-checkpoint",
  "local-binding",
])("requires separately retained expectations after %s changes", async (change) => {
  const f = await fixture(),
    result = await describeRunArchiveAssets(f),
    payload = clone(result.payload);
  if (change === "manifest") payload.manifest.entries.push(manifest(40).entries[0]);
  if (change === "original-images") {
    payload.originalImages.entries.push(manifest(40).entries[0]);
    payload.manifest.entries.push(manifest(40).entries[0]);
  }
  if (change === "per-run") {
    payload.history.effectSets[0].history.baseline.manifest.entries.push(manifest(40).entries[0]);
    payload.manifest.entries.push(manifest(40).entries[0]);
  }
  if (change === "provenance") payload.binding.checkpoint.selection.effectSets[0].source = "rebase";
  if (change === "current-checkpoint") payload.assetCheckpoint.sha256 = "b".repeat(64);
  if (change === "local-binding") {
    payload.binding.localCheckpoint.sha256 = "b".repeat(64);
    payload.assetCheckpoint.binding.localCheckpoint.sha256 = "b".repeat(64);
  }
  expect(() => parseRunArchiveAssetPayload(payload)).not.toThrow();
  await expect(
    requireRunArchiveAssetCheckpoint(payload, result.checkpoint, identity, f),
  ).rejects.toThrow();
});
it.each([
  "localSnapshot",
  "sharedHistory",
  "executions",
  "originalActions",
  "actionArchive",
  "runArchive",
  "currentAssets",
] as const)(
  "verifies actual %s contents rather than supplied descriptor metadata",
  async (name) => {
    const f = await fixture(),
      result = await describeRunArchiveAssets(f);
    if (name === "localSnapshot")
      f.localSnapshot.tables.find((t: any) => t.name === "local_image_upload").rows[0].created_at =
        ["integer", "9007199254740994"];
    if (name === "sharedHistory") {
      f.sharedHistory.history.effectSets[0].effects[0].after.name = ["text", reference(17)];
      f.sharedHistory.history.effectSets[0].effects[1].before.name = ["text", reference(17)];
    }
    if (name === "executions") f.executions.effectSets[0].executions[1].input.text = "changed";
    if (name === "originalActions") f.originalActions.actions[2].input.text = "changed";
    if (name === "actionArchive") f.actionArchive.actions[2].hlc = "changed";
    if (name === "runArchive")
      f.runArchive.effectSets[5].executions.effectSets[0].executions[1].input.text = "changed";
    if (name === "currentAssets") {
      f.currentAssets.history.effectSets[1].manifest.entries.find(
        (e: any) => e.name === manifest(15).entries[0].name,
      ).byteLength = 4;
      f.currentAssets.manifest.entries.find(
        (e: any) => e.name === manifest(15).entries[0].name,
      ).byteLength = 4;
    }
    await expect(
      requireRunArchiveAssetCheckpoint(result.payload, result.checkpoint, identity, f),
    ).rejects.toThrow();
  },
);
it("checks current local coverage even when all outer asset hashes are deliberately recomputed", async () => {
  const f = await fixture();
  f.currentAssets.manifest.entries = f.currentAssets.manifest.entries.filter(
    (e: any) => e.name !== manifest(13).entries[0].name,
  );
  f.assetCheckpoint = {
    version: 1,
    binding: f.currentAssets.binding,
    byteLength: Buffer.byteLength(JSON.stringify(f.currentAssets)),
    sha256: createHash("sha256").update(JSON.stringify(f.currentAssets)).digest("hex"),
  };
  await expect(describeRunArchiveAssets(f)).rejects.toThrow();
});
it.each(["extra", "current-only", "original-only"])(
  "requires recomputed coverage after %s manifest drift even when the outer digest matches",
  async (change) => {
    const f = await fixture(),
      result = await describeRunArchiveAssets(f),
      payload = clone(result.payload);
    if (change === "extra") payload.manifest.entries.push(manifest(40).entries[0]);
    if (change === "current-only")
      payload.manifest.entries = payload.manifest.entries.filter(
        (entry: any) => entry.name !== manifest(15).entries[0].name,
      );
    if (change === "original-only")
      payload.originalImages.entries = payload.originalImages.entries.filter(
        (entry: any) => entry.name !== manifest(11).entries[0].name,
      );
    const parsed = parseRunArchiveAssetPayload(payload);
    await expect(
      requireRunArchiveAssetCheckpoint(parsed, descriptor(parsed), identity, f),
    ).rejects.toThrow();
  },
);
it.each(["description", "verification"])(
  "owns all seven sources and manifest metadata before the first digest during %s",
  async (mode) => {
    const f = await fixture(),
      result = await describeRunArchiveAssets(f),
      input = clone(f),
      payload = clone(result.payload),
      checkpoint = clone(result.checkpoint),
      expected = { ...identity },
      digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      input.localSnapshot.tables.length = 0;
      input.sharedHistory.history.effectSets.length = 0;
      input.executions.effectSets.length = 0;
      input.originalActions.actions.length = 0;
      input.actionArchive.actions.length = 0;
      input.runArchive.effectSets.length = 0;
      input.currentAssets.manifest.entries.length = 0;
      input.history.effectSets.length = 0;
      input.originalImages.entries.length = 0;
      input.binding.localCheckpoint.sha256 = "b".repeat(64);
      input.assetCheckpoint.sha256 = "b".repeat(64);
      payload.history.effectSets.length = 0;
      checkpoint.sha256 = "b".repeat(64);
      expected.deviceId = "changed";
      return digest(...args);
    });
    const actual =
      mode === "description"
        ? (await describeRunArchiveAssets(input)).payload
        : await requireRunArchiveAssetCheckpoint(payload, checkpoint, expected, input);
    expect(actual).toEqual(result.payload);
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "requires expected %s before hashing",
  async (field) => {
    const f = await fixture(),
      result = await describeRunArchiveAssets(f),
      digest = vi.spyOn(crypto.subtle, "digest");
    await expect(
      requireRunArchiveAssetCheckpoint(
        result.payload,
        result.checkpoint,
        { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        f,
      ),
    ).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);
it.each([
  "getter",
  "array-getter",
  "extra-field",
  "version",
  "missing-originals",
  "omitted-manifest",
])("refuses %s transport without invoking hooks", async (change) => {
  const f = await fixture(),
    result = await describeRunArchiveAssets(f),
    payload = clone(result.payload),
    hook = vi.fn();
  if (change === "getter")
    Object.defineProperty(payload, "history", { enumerable: true, get: hook });
  if (change === "array-getter")
    Object.defineProperty(payload.history.effectSets, "0", { enumerable: true, get: hook });
  if (change === "extra-field") payload.extra = true;
  if (change === "version") payload.version++;
  if (change === "missing-originals") delete payload.originalImages;
  if (change === "omitted-manifest") payload.manifest.entries = [];
  expect(() => parseRunArchiveAssetPayload(payload)).toThrow();
  expect(hook).not.toHaveBeenCalled();
});
it.each(["version", "hash", "hash-newline", "length", "local-selection", "source-binding"])(
  "refuses malformed %s descriptor metadata",
  async (change) => {
    const f = await fixture(),
      result = await describeRunArchiveAssets(f),
      checkpoint = clone(result.checkpoint);
    if (change === "version") checkpoint.version++;
    if (change === "hash") checkpoint.sha256 = "A".repeat(64);
    if (change === "hash-newline") checkpoint.sha256 += "\n";
    if (change === "length") checkpoint.byteLength = 0;
    if (change === "local-selection")
      checkpoint.binding.localCheckpoint.selection.effectSetIds = [];
    if (change === "source-binding")
      checkpoint.assetCheckpoint.binding.localCheckpoint.sha256 = "b".repeat(64);
    expect(() => parseRunArchiveAssetCheckpoint(checkpoint)).toThrow();
  },
);
it("inspects historical descriptor metadata without accepting old-schema manifest payloads", async () => {
  const f = await fixture(),
    result = await describeRunArchiveAssets(f),
    checkpoint = clone(result.checkpoint),
    old = migrations.at(-2)!.id;
  checkpoint.binding.localCheckpoint.identity.schemaId = old;
  checkpoint.binding.checkpoint.checkpoint.checkpoint.checkpoint.checkpoint.identity.schemaId = old;
  checkpoint.assetCheckpoint.binding.localCheckpoint.identity.schemaId = old;
  checkpoint.assetCheckpoint.binding.checkpoint.identity.schemaId = old;
  expect(parseRunArchiveAssetCheckpoint(checkpoint)).toEqual(checkpoint);
  expect(() =>
    parseRunArchiveAssetPayload({
      ...result.payload,
      binding: checkpoint.binding,
      assetCheckpoint: checkpoint.assetCheckpoint,
    }),
  ).toThrow("Unsupported");
});

it.each([
  "detached-baseline",
  "detached-intermediate",
  "detached-origin-child",
  "detached-rebase-child",
  "detached-grandchild",
  "detached-skipped",
  "archived-original-child",
  "archived-original-grandchild",
  "archived-original-skipped",
])("requires independent %s coverage", async (gap) => {
  const f = await fixture(),
    origin = f.history.effectSets.find((e: any) => e.id === "detached-origin"),
    rebase = f.history.effectSets.find((e: any) => e.id === "detached-rebase");
  const first = gap.startsWith("archived-original-");
  const n =
    gap === "detached-baseline"
      ? 21
      : gap === "detached-intermediate"
        ? 22
        : gap === "detached-origin-child" || gap === "archived-original-child"
          ? 18
          : gap === "detached-rebase-child"
            ? 23
            : gap === "detached-grandchild"
              ? 24
              : gap === "archived-original-grandchild"
                ? 19
                : 20;
  const target = first
    ? f.originalImages
    : gap === "detached-baseline"
      ? origin.history.baseline.manifest
      : gap === "detached-rebase-child" || gap === "detached-grandchild"
        ? rebase.history.effectSets[0].manifest
        : origin.history.effectSets[0].manifest;
  const index = target.entries.findIndex((e: any) => e.name === manifest(n).entries[0].name);
  expect(index).toBeGreaterThanOrEqual(0);
  const [removed] = target.entries.splice(index, 1);
  const elsewhere = f.history.effectSets[0].history.effectSets[0].manifest;
  if (!elsewhere.entries.some((e: any) => e.name === removed.name)) elsewhere.entries.push(removed);
  await expect(describeRunArchiveAssets(f)).rejects.toThrow();
});
it("requires a first-recorded child that never executes in any archived run", async () => {
  const f = await fixture(),
    root = f.actionArchive.actions.find((a: any) => a.id === "detached");
  root.generated.never = { type: "child-id", value: "detached-never" };
  const never = {
    ...clone(root),
    id: "detached-never",
    parentId: root.id,
    kind: "future.never",
    input: { ref: reference(32) },
    generated: {},
    seq: "6",
  };
  f.actionArchive.actions.splice(5, 0, never);
  f.actionArchive.selection.actionIds = f.actionArchive.actions.map((a: any) => a.id);
  const actionArchive = await describeSharedRecoveryActionArchive({
    checkpoint: f.actionArchive.checkpoint,
    selection: f.actionArchive.selection,
    actions: f.actionArchive.actions,
    originals: f.originalActions,
    executions: f.executions,
    sharedHistory: f.sharedHistory,
  });
  for (const set of f.runArchive.effectSets)
    if (set.rootId === root.id) set.executions.effectSets[0].generated = root.generated;
  const runArchive = await describeSharedRecoveryRunArchive({
    checkpoint: actionArchive.checkpoint,
    selection: f.runArchive.selection,
    effectSets: f.runArchive.effectSets,
    actionArchive: actionArchive.payload,
    originals: f.originalActions,
    executions: f.executions,
    sharedHistory: f.sharedHistory,
  });
  f.actionArchive = actionArchive.payload;
  f.runArchive = runArchive.payload;
  f.binding.checkpoint = runArchive.checkpoint;
  await expect(describeRunArchiveAssets(f)).rejects.toThrow();
  f.originalImages.entries.push(manifest(32).entries[0]);
  const result = await describeRunArchiveAssets(f);
  expect(result.payload.manifest.entries.some((e) => e.name === manifest(32).entries[0].name)).toBe(
    true,
  );
});
it.each([false, true])(
  "keeps current and local requirements with no selected runs (extra archived runs=%s)",
  async (includeRuns) => {
    const f = await fixture(),
      expected = { ...identity, checkpointId: "baseline-only" };
    const shared = await describeSharedRecoveryHistory(
      { baseline: f.sharedHistory.history.baseline, effectSets: [] },
      expected,
      { baselineId: "baseline", effectSets: [] },
    );
    const local = await describeLocalRecoverySnapshot({
      ...f.localSnapshot,
      identity: expected,
      selection: { baselineId: "baseline", effectSetIds: [] },
    });
    const execution = await describeSharedRecoveryExecutions({
      checkpoint: shared.checkpoint,
      sharedHistory: shared.payload,
      selection: { baselineId: "baseline", effectSets: [] },
      effectSets: [],
    });
    const original = await describeSharedRecoveryActions({
      checkpoint: execution.checkpoint,
      executions: execution.payload,
      sharedHistory: shared.payload,
      selection: { actionIds: [] },
      actions: [],
    });
    const actions = f.actionArchive.actions.filter((a: any) => a.rootId === "detached");
    const actionArchive = await describeSharedRecoveryActionArchive({
      checkpoint: original.checkpoint,
      originals: original.payload,
      executions: execution.payload,
      sharedHistory: shared.payload,
      selection: { rootIds: ["detached"], actionIds: actions.map((a: any) => a.id) },
      actions,
    });
    const sets = [];
    if (includeRuns)
      for (const set of f.runArchive.effectSets.filter((s: any) => s.rootId === "detached")) {
        const history = await describeSharedRecoveryHistory(
          set.history.history,
          expected,
          set.history.selection,
        );
        const execution = await describeSharedRecoveryExecutions({
          checkpoint: history.checkpoint,
          sharedHistory: history.payload,
          selection: set.executions.selection,
          effectSets: set.executions.effectSets,
        });
        sets.push({ ...set, history: history.payload, executions: execution.payload });
      }
    const runArchive = await describeSharedRecoveryRunArchive({
      checkpoint: actionArchive.checkpoint,
      actionArchive: actionArchive.payload,
      originals: original.payload,
      executions: execution.payload,
      sharedHistory: shared.payload,
      selection: {
        effectSets: includeRuns
          ? f.runArchive.selection.effectSets.filter((s: any) => s.rootId === "detached")
          : [],
      },
      effectSets: sets,
    });
    const current = await describeRecoveryAssets({
      binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
      localSnapshot: local.snapshot,
      sharedHistory: shared.payload,
      history: { baseline: { id: "baseline", manifest: manifest(1) }, effectSets: [] },
    });
    const contents: RunArchiveAssetSources = {
      localSnapshot: local.snapshot,
      sharedHistory: shared.payload,
      executions: execution.payload,
      originalActions: original.payload,
      actionArchive: actionArchive.payload,
      runArchive: runArchive.payload,
      currentAssets: current.payload,
    };
    const result = await describeRunArchiveAssets({
      ...contents,
      binding: { checkpoint: runArchive.checkpoint, localCheckpoint: local.checkpoint },
      assetCheckpoint: current.checkpoint,
      history: {
        effectSets: includeRuns
          ? f.history.effectSets.filter((s: any) => s.id.startsWith("detached-"))
          : [],
      },
      originalImages: manifest(17, 18, 19, 20),
    });
    expect(result.payload.manifest).toEqual(
      includeRuns
        ? manifest(1, 13, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30)
        : manifest(1, 13, 17, 18, 19, 20),
    );
    expect(
      await requireRunArchiveAssetCheckpoint(result.payload, result.checkpoint, expected, contents),
    ).toEqual(result.payload);
  },
);

it("canonicalizes per-manifest entry order without changing trusted inventory order", async () => {
  const f = await fixture(),
    expected = await describeRunArchiveAssets(f);
  f.originalImages.entries.reverse();
  for (const { history } of f.history.effectSets) {
    history.baseline.manifest.entries.reverse();
    for (const { manifest } of history.effectSets) manifest.entries.reverse();
  }
  expect((await describeRunArchiveAssets(f)).checkpoint).toEqual(expected.checkpoint);
});
it("keeps selected-root retained manifests and broader run manifests as distinct formats", async () => {
  const broader = await describeRunArchiveAssets(await fixture());
  expect(() => parseRetainedRecoveryAssetPayload(broader.payload)).toThrow();
  const selected = await describeRetainedRecoveryAssets(await retainedRecoveryAssetFixture());
  expect(() => parseRunArchiveAssetPayload(selected.payload)).toThrow();
});
