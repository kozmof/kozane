import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { migrations } from "@kozane/core/migrations";
import {
  describeLocalRecoverySnapshot,
  describeSharedRecoveryHistory,
  describeSharedRecoveryExecutions,
  describeSharedRecoveryActions,
  describeSharedRecoveryRetainedHistory,
  describeRecoveryAssets,
  describeRetainedRecoveryAssets,
  parseRetainedRecoveryAssetPayload,
  parseRetainedRecoveryAssetCheckpoint,
  requireRetainedRecoveryAssetCheckpoint,
  parseSharedRecoveryRetainedImages,
  type SharedRecoveryEffectSetSource,
  type RetainedRecoveryAssetSources,
} from "@kozane/core/recovery";
import { capturedTables } from "../../test-utils/action-tables.js";
import { localTableNames } from "../../../../core/src/actions/local-tables.js";
const identity = {
  workspaceId: "workspace🪁",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const filename = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
const reference = (n: number) => `kozane-image:/api/images/${filename(n)}`;
const manifest = (...ns: number[]) => ({
  version: 1 as const,
  entries: ns.map((n) => ({
    name: `.kozane/assets/images/${filename(n)}`,
    byteLength: 3,
    sha256: "a".repeat(64),
  })),
});
const row = (n: number) => ({
  id: ["text", "n"],
  name: ["text", reference(n)],
  is_default: ["integer", "0"],
});
const projection = (n?: number) => ({
  version: 1,
  rowEncodingVersion: 1,
  schemaId: identity.schemaId,
  tables: capturedTables.map(({ name }) => ({
    name,
    rows: name === "namespace" && n !== undefined ? [row(n)] : [],
  })),
});
const effects = (from: number, to: number) => [
  {
    ord: 0,
    table: "namespace",
    key: { id: ["text", "n"] },
    op: "U",
    before: row(from),
    after: row(to),
  },
  { ord: 1, table: "namespace", key: { id: ["text", "n"] }, op: "D", before: row(to), after: null },
];
const clone = (value: unknown) => JSON.parse(JSON.stringify(value));
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const root = {
      id: "root",
      kind: "future.root",
      contractVersion: 99,
      input: { ref: reference(0), text: '\ufeff{"text":"exact"}\0🪁' },
    },
    generated = {
      child: { type: "child-id", value: "child" },
      skipped: { type: "child-id", value: "skipped" },
      unused: { type: "entity-id", value: "unused" },
    };
  const group = (id: string, child?: number) => ({
    id,
    invocation: root,
    generated,
    executions: [
      {
        ...root,
        parentId: null,
        executionOrd: 0,
        generated: child === undefined ? {} : { child: generated.child },
      },
      ...(child === undefined
        ? []
        : [
            {
              id: "child",
              kind: "future.child",
              contractVersion: 99,
              parentId: "root",
              executionOrd: 1,
              input: { ref: reference(child) },
              generated: {},
            },
          ]),
    ],
    effects:
      child === undefined
        ? []
        : [
            { ord: 0, actionId: "child", executionOrd: 1 },
            { ord: 1, actionId: "root", executionOrd: 0 },
          ],
  });
  const shared = await describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection: projection(1) },
      effectSets: [
        { id: "rebase", effects: effects(1, 2) },
        { id: "noop", effects: [] },
      ],
    },
    identity,
    {
      baselineId: "baseline",
      effectSets: [
        { id: "rebase", effectCount: 2 },
        { id: "noop", effectCount: 0 },
      ],
    },
  );
  const local = await describeLocalRecoverySnapshot({
    version: 1,
    rowEncodingVersion: 1,
    identity,
    selection: { baselineId: "baseline", effectSetIds: ["rebase", "noop"] },
    tables: localTableNames.map((name) => ({
      name,
      rows:
        name === "local_image_upload"
          ? [
              {
                filename: ["text", filename(13)],
                byte_length: ["integer", "3"],
                sha256: ["text", "a".repeat(64)],
                state: ["text", "pending"],
                created_at: ["integer", "9007199254740993"],
                installed_at: ["null"],
                completed_at: ["null"],
                error: ["null"],
                abandoned_at: ["null"],
                abandon_reason: ["null"],
              },
            ]
          : [],
    })),
  });
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: shared.checkpoint,
    sharedHistory: shared.payload,
    selection: {
      baselineId: "baseline",
      effectSets: [
        { id: "rebase", rootId: "root", executionCount: 2 },
        { id: "noop", rootId: "root", executionCount: 1 },
      ],
    },
    effectSets: [group("rebase", 10), group("noop")],
  });
  const provenance = {
    deviceId: "first-device",
    epochId: identity.epochId,
    schemaId: identity.schemaId,
    hlc: "opaque:first-record",
  };
  const originals = await describeSharedRecoveryActions({
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: shared.payload,
    selection: { actionIds: ["root", "child", "skipped"] },
    actions: [
      { ...root, rootId: "root", parentId: null, generated, seq: "1", ...provenance },
      {
        id: "child",
        rootId: "root",
        parentId: "root",
        kind: "future.child",
        contractVersion: 99,
        input: { ref: reference(11) },
        generated: {},
        seq: "2",
        ...provenance,
      },
      {
        id: "skipped",
        rootId: "root",
        parentId: "root",
        kind: "future.skipped",
        contractVersion: 99,
        input: { ref: reference(12) },
        generated: {},
        seq: "9007199254740993",
        ...provenance,
      },
    ],
  });
  const sets = [],
    inventory = [],
    images = [];
  for (const [id, source, before, after, child] of [
    ["origin", "origin", 4, 5, 9],
    ["noop", "authoritative", undefined, undefined, undefined],
    ["superseded", "rebase", 6, 7, 8],
    ["rebase", "rebase", 1, 2, 10],
  ] as const) {
    const fx = before === undefined ? [] : effects(before, after!);
    const history = await describeSharedRecoveryHistory(
      {
        baseline: { id: `ctx-${id}`, projection: projection(before) },
        effectSets: [{ id, effects: fx }],
      },
      identity,
      { baselineId: `ctx-${id}`, effectSets: [{ id, effectCount: fx.length }] },
    );
    const run = await describeSharedRecoveryExecutions({
      checkpoint: history.checkpoint,
      sharedHistory: history.payload,
      selection: {
        baselineId: `ctx-${id}`,
        effectSets: [{ id, rootId: "root", executionCount: child === undefined ? 1 : 2 }],
      },
      effectSets: [group(id, child)],
    });
    sets.push({
      id,
      rootId: "root",
      source: source as SharedRecoveryEffectSetSource,
      history: history.payload,
      executions: run.payload,
    });
    inventory.push({
      id,
      rootId: "root",
      source: source as SharedRecoveryEffectSetSource,
      baselineId: `ctx-${id}`,
      effectCount: fx.length,
      executionCount: child === undefined ? 1 : 2,
    });
    images.push({
      id,
      history: {
        baseline: {
          id: `ctx-${id}`,
          manifest: manifest(...(before === undefined ? [] : [before])),
        },
        effectSets: [
          {
            id,
            manifest: manifest(
              0,
              ...(child === undefined ? [] : [before!, after!, child]),
              ...(id === "origin" ? [14] : []),
            ),
          },
        ],
      },
    });
  }
  const retained = await describeSharedRecoveryRetainedHistory({
    checkpoint: originals.checkpoint,
    selection: { effectSets: inventory },
    effectSets: sets,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
  });
  const assets = await describeRecoveryAssets({
    binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    history: {
      baseline: { id: "baseline", manifest: manifest(1) },
      effectSets: [
        { id: "rebase", manifest: manifest(0, 1, 2, 10) },
        { id: "noop", manifest: manifest(0, 15) },
      ],
    },
  });
  return clone({
    binding: { checkpoint: retained.checkpoint, localCheckpoint: local.checkpoint },
    assetCheckpoint: assets.checkpoint,
    history: { effectSets: images },
    originalImages: manifest(0, 11, 12, 16),
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    executions: executions.payload,
    originalActions: originals.payload,
    retainedHistory: retained.payload,
    currentAssets: assets.payload,
  });
}
function descriptor(payload: ReturnType<typeof parseRetainedRecoveryAssetPayload>) {
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
    result = await describeRetainedRecoveryAssets(f);
  expect(result.payload.manifest).toEqual(
    manifest(0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16),
  );
  expect(result.payload.history).toEqual(f.history);
  expect(result.payload.originalImages).toEqual(f.originalImages);
  expect(result.checkpoint).toEqual(descriptor(result.payload));
  expect(result.checkpoint.byteLength).toBeGreaterThan(JSON.stringify(result.payload).length);
  expect(
    await requireRetainedRecoveryAssetCheckpoint(result.payload, result.checkpoint, identity, f),
  ).toEqual(result.payload);
  expect(parseRetainedRecoveryAssetCheckpoint(result.checkpoint)).toEqual(result.checkpoint);
  expect(parseSharedRecoveryRetainedImages(f.history)).toEqual(f.history);
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
      f.history.effectSets[2].history.baseline.manifest.entries.push(
        remove(f.history.effectSets[0].history.baseline.manifest, 4),
      );
    if (gap === "intermediate")
      f.history.effectSets[2].history.effectSets[0].manifest.entries.push(
        remove(f.history.effectSets[0].history.effectSets[0].manifest, 5),
      );
    if (gap === "origin-input")
      f.history.effectSets[2].history.effectSets[0].manifest.entries.push(
        remove(f.history.effectSets[0].history.effectSets[0].manifest, 9),
      );
    if (gap === "superseded-input")
      f.history.effectSets[0].history.effectSets[0].manifest.entries.push(
        remove(f.history.effectSets[2].history.effectSets[0].manifest, 8),
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
    await expect(describeRetainedRecoveryAssets(f)).rejects.toThrow();
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
    await expect(describeRetainedRecoveryAssets(f)).rejects.toThrow("selection mismatch");
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
    await expect(describeRetainedRecoveryAssets(f)).rejects.toThrow();
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
    result = await describeRetainedRecoveryAssets(f),
    payload = clone(result.payload);
  if (change === "manifest") payload.manifest.entries.push(manifest(17).entries[0]);
  if (change === "original-images") {
    payload.originalImages.entries.push(manifest(17).entries[0]);
    payload.manifest.entries.push(manifest(17).entries[0]);
  }
  if (change === "per-run") {
    payload.history.effectSets[0].history.baseline.manifest.entries.push(manifest(17).entries[0]);
    payload.manifest.entries.push(manifest(17).entries[0]);
  }
  if (change === "provenance") payload.binding.checkpoint.selection.effectSets[0].source = "rebase";
  if (change === "current-checkpoint") payload.assetCheckpoint.sha256 = "b".repeat(64);
  if (change === "local-binding") {
    payload.binding.localCheckpoint.sha256 = "b".repeat(64);
    payload.assetCheckpoint.binding.localCheckpoint.sha256 = "b".repeat(64);
  }
  expect(() => parseRetainedRecoveryAssetPayload(payload)).not.toThrow();
  await expect(
    requireRetainedRecoveryAssetCheckpoint(payload, result.checkpoint, identity, f),
  ).rejects.toThrow();
});
it.each([
  "localSnapshot",
  "sharedHistory",
  "executions",
  "originalActions",
  "retainedHistory",
  "currentAssets",
] as const)(
  "verifies actual %s contents rather than supplied descriptor metadata",
  async (name) => {
    const f = await fixture(),
      result = await describeRetainedRecoveryAssets(f);
    if (name === "localSnapshot")
      f.localSnapshot.tables.find((t: any) => t.name === "local_image_upload").rows[0].created_at =
        ["integer", "9007199254740994"];
    if (name === "sharedHistory") {
      f.sharedHistory.history.effectSets[0].effects[0].after.name = ["text", reference(17)];
      f.sharedHistory.history.effectSets[0].effects[1].before.name = ["text", reference(17)];
    }
    if (name === "executions") f.executions.effectSets[0].executions[1].input.text = "changed";
    if (name === "originalActions") f.originalActions.actions[2].input.text = "changed";
    if (name === "retainedHistory")
      f.retainedHistory.effectSets[2].executions.effectSets[0].executions[1].input.text = "changed";
    if (name === "currentAssets") {
      f.currentAssets.history.effectSets[1].manifest.entries.find(
        (e: any) => e.name === manifest(15).entries[0].name,
      ).byteLength = 4;
      f.currentAssets.manifest.entries.find(
        (e: any) => e.name === manifest(15).entries[0].name,
      ).byteLength = 4;
    }
    await expect(
      requireRetainedRecoveryAssetCheckpoint(result.payload, result.checkpoint, identity, f),
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
  await expect(describeRetainedRecoveryAssets(f)).rejects.toThrow();
});
it.each(["extra", "current-only", "original-only"])(
  "requires recomputed coverage after %s manifest drift even when the outer digest matches",
  async (change) => {
    const f = await fixture(),
      result = await describeRetainedRecoveryAssets(f),
      payload = clone(result.payload);
    if (change === "extra") payload.manifest.entries.push(manifest(17).entries[0]);
    if (change === "current-only")
      payload.manifest.entries = payload.manifest.entries.filter(
        (entry: any) => entry.name !== manifest(15).entries[0].name,
      );
    if (change === "original-only")
      payload.originalImages.entries = payload.originalImages.entries.filter(
        (entry: any) => entry.name !== manifest(11).entries[0].name,
      );
    const parsed = parseRetainedRecoveryAssetPayload(payload);
    await expect(
      requireRetainedRecoveryAssetCheckpoint(parsed, descriptor(parsed), identity, f),
    ).rejects.toThrow();
  },
);
it.each(["description", "verification"])(
  "owns all six sources and manifest metadata before the first digest during %s",
  async (mode) => {
    const f = await fixture(),
      result = await describeRetainedRecoveryAssets(f),
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
      input.retainedHistory.effectSets.length = 0;
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
        ? (await describeRetainedRecoveryAssets(input)).payload
        : await requireRetainedRecoveryAssetCheckpoint(payload, checkpoint, expected, input);
    expect(actual).toEqual(result.payload);
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "requires expected %s before hashing",
  async (field) => {
    const f = await fixture(),
      result = await describeRetainedRecoveryAssets(f),
      digest = vi.spyOn(crypto.subtle, "digest");
    await expect(
      requireRetainedRecoveryAssetCheckpoint(
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
    result = await describeRetainedRecoveryAssets(f),
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
  expect(() => parseRetainedRecoveryAssetPayload(payload)).toThrow();
  expect(hook).not.toHaveBeenCalled();
});
it.each(["version", "hash", "hash-newline", "length", "local-selection", "source-binding"])(
  "refuses malformed %s descriptor metadata",
  async (change) => {
    const f = await fixture(),
      result = await describeRetainedRecoveryAssets(f),
      checkpoint = clone(result.checkpoint);
    if (change === "version") checkpoint.version++;
    if (change === "hash") checkpoint.sha256 = "A".repeat(64);
    if (change === "hash-newline") checkpoint.sha256 += "\n";
    if (change === "length") checkpoint.byteLength = 0;
    if (change === "local-selection")
      checkpoint.binding.localCheckpoint.selection.effectSetIds = [];
    if (change === "source-binding")
      checkpoint.assetCheckpoint.binding.localCheckpoint.sha256 = "b".repeat(64);
    expect(() => parseRetainedRecoveryAssetCheckpoint(checkpoint)).toThrow();
  },
);
it("inspects historical descriptor metadata without accepting old-schema manifest payloads", async () => {
  const f = await fixture(),
    result = await describeRetainedRecoveryAssets(f),
    checkpoint = clone(result.checkpoint),
    old = migrations.at(-2)!.id;
  checkpoint.binding.localCheckpoint.identity.schemaId = old;
  checkpoint.binding.checkpoint.checkpoint.checkpoint.checkpoint.identity.schemaId = old;
  checkpoint.assetCheckpoint.binding.localCheckpoint.identity.schemaId = old;
  checkpoint.assetCheckpoint.binding.checkpoint.identity.schemaId = old;
  expect(parseRetainedRecoveryAssetCheckpoint(checkpoint)).toEqual(checkpoint);
  expect(() =>
    parseRetainedRecoveryAssetPayload({
      ...result.payload,
      binding: checkpoint.binding,
      assetCheckpoint: checkpoint.assetCheckpoint,
    }),
  ).toThrow("Unsupported");
});
it("prepares a baseline-only archive while retaining current baseline and local image requirements", async () => {
  const f = await fixture();
  const shared = await describeSharedRecoveryHistory(
    { baseline: f.sharedHistory.history.baseline, effectSets: [] },
    identity,
    { baselineId: "baseline", effectSets: [] },
  );
  const local = await describeLocalRecoverySnapshot({
    ...f.localSnapshot,
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
  const retained = await describeSharedRecoveryRetainedHistory({
    checkpoint: original.checkpoint,
    originals: original.payload,
    executions: execution.payload,
    sharedHistory: shared.payload,
    selection: { effectSets: [] },
    effectSets: [],
  });
  const current = await describeRecoveryAssets({
    binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    history: { baseline: { id: "baseline", manifest: manifest(1) }, effectSets: [] },
  });
  const contents: RetainedRecoveryAssetSources = {
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    executions: execution.payload,
    originalActions: original.payload,
    retainedHistory: retained.payload,
    currentAssets: current.payload,
  };
  const result = await describeRetainedRecoveryAssets({
    ...contents,
    binding: { checkpoint: retained.checkpoint, localCheckpoint: local.checkpoint },
    assetCheckpoint: current.checkpoint,
    history: { effectSets: [] },
    originalImages: manifest(),
  });
  expect(result.payload.manifest).toEqual(manifest(1, 13));
  expect(
    await requireRetainedRecoveryAssetCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      contents,
    ),
  ).toEqual(result.payload);
});
