import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrations } from "../../../../core/src/generated/migrations.js";
import {
  parseSharedRecoveryProjection,
  type SharedRecoveryEffect,
} from "../../../../core/src/actions/shared-recovery.js";
import { describeSharedRecoveryHistory } from "../../../../core/src/actions/shared-recovery-checkpoint.js";
import {
  sharedRecoveryAssetManifest,
  parseSharedRecoveryHistoryImages,
} from "../../../../core/src/actions/shared-recovery-assets.js";
import { capturedTables } from "../../test-utils/action-tables.js";
const filename = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
const name = (n: number) => `.kozane/assets/images/${filename(n)}`;
const reference = (n: number) => `kozane-image:/api/images/${filename(n)}`;
const manifest = (...numbers: number[]) => ({
  version: 1 as const,
  entries: numbers.map((n) => ({ name: name(n), byteLength: 3, sha256: "a".repeat(64) })),
});
const row = (n: number) => ({
  id: ["text", "n"] as const,
  name: ["text", reference(n)] as const,
  is_default: ["integer", "0"] as const,
});
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const identity = {
    workspaceId: "workspace",
    deviceId: "device",
    epochId: "epoch",
    checkpointId: "checkpoint",
    schemaId: migrations.at(-1)!.id,
  };
  const projection = parseSharedRecoveryProjection({
    version: 1,
    rowEncodingVersion: 1,
    schemaId: identity.schemaId,
    tables: capturedTables.map(({ name }) => ({
      name,
      rows: name === "namespace" ? [row(1)] : [],
    })),
  });
  const effects: SharedRecoveryEffect[] = [
    {
      ord: 0,
      table: "namespace",
      key: { id: ["text", "n"] },
      op: "U",
      before: row(1),
      after: row(2),
    },
    {
      ord: 1,
      table: "namespace",
      key: { id: ["text", "n"] },
      op: "U",
      before: row(2),
      after: row(3),
    },
    {
      ord: 2,
      table: "namespace",
      key: { id: ["text", "n"] },
      op: "D",
      before: row(3),
      after: null,
    },
  ];
  const described = await describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection },
      effectSets: [
        { id: "edit", effects },
        { id: "empty", effects: [] },
      ],
    },
    identity,
    {
      baselineId: "baseline",
      effectSets: [
        { id: "edit", effectCount: 3 },
        { id: "empty", effectCount: 0 },
      ],
    },
  );
  const images = {
    baseline: { id: "baseline", manifest: manifest(1) },
    effectSets: [
      { id: "edit", manifest: manifest(1, 2, 3) },
      { id: "empty", manifest: manifest(4) },
    ],
  };
  return { ...described, images };
}

it("requires baseline and intermediate row images even after every live row is deleted", async () => {
  const f = await fixture();
  expect(f.projection.tables.every(({ rows }) => rows.length === 0)).toBe(true);
  expect(sharedRecoveryAssetManifest(f.payload, f.images)).toEqual(manifest(1, 2, 3, 4));
});

it.each(["baseline", "before-image", "intermediate", "deleted-image"])(
  "refuses missing %s requirements in the corresponding history record",
  async (missing) => {
    const f = await fixture();
    if (missing === "baseline") f.images.baseline.manifest = manifest();
    if (missing === "before-image") f.images.effectSets[0].manifest = manifest(2, 3);
    if (missing === "intermediate") f.images.effectSets[0].manifest = manifest(1, 3);
    if (missing === "deleted-image") f.images.effectSets[0].manifest = manifest(1, 2);
    expect(() => sharedRecoveryAssetManifest(f.payload, f.images)).toThrow(
      "Required asset is missing",
    );
  },
);

it("preserves additional invocation requirements instead of reducing manifests to row references", async () => {
  const f = await fixture();
  f.images.baseline.manifest = manifest(1, 5);
  expect(sharedRecoveryAssetManifest(f.payload, f.images)).toEqual(manifest(1, 2, 3, 4, 5));
});

it.each(["baseline", "missing", "extra", "reordered", "duplicate"])(
  "refuses %s manifest identities",
  async (change) => {
    const f = await fixture();
    if (change === "baseline") f.images.baseline.id = "other";
    if (change === "missing") f.images.effectSets.pop();
    if (change === "extra") f.images.effectSets.push({ id: "extra", manifest: manifest() });
    if (change === "reordered") f.images.effectSets.reverse();
    if (change === "duplicate") f.images.effectSets[1].id = "edit";
    expect(() => sharedRecoveryAssetManifest(f.payload, f.images)).toThrow("checkpoint selection");
  },
);

it("refuses conflicting immutable bytes across baseline and effect-set manifests", async () => {
  const f = await fixture();
  f.images.effectSets[0].manifest.entries[0].sha256 = "b".repeat(64);
  expect(() => sharedRecoveryAssetManifest(f.payload, f.images)).toThrow("Conflicting asset bytes");
});

it("owns canonical manifest data and leaves caller inputs unchanged", async () => {
  const f = await fixture();
  f.images.effectSets[0].manifest.entries.reverse();
  const before = JSON.stringify(f.images);
  const result = sharedRecoveryAssetManifest(f.payload, f.images);
  expect(JSON.stringify(f.images)).toBe(before);
  expect(Object.isFrozen(result.entries[0])).toBe(true);
  f.images.effectSets[0].manifest.entries[0].sha256 = "b".repeat(64);
  expect(result).toEqual(manifest(1, 2, 3, 4));
});

it("rejects accessor and sparse metadata without invoking getters", async () => {
  const f = await fixture();
  const getter = vi.fn(() => f.images.baseline);
  Object.defineProperty(f.images, "baseline", { enumerable: true, get: getter });
  expect(() => parseSharedRecoveryHistoryImages(f.images)).toThrow("plain data");
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    parseSharedRecoveryHistoryImages({
      baseline: { id: "baseline", manifest: manifest() },
      effectSets: new Array(2),
    }),
  ).toThrow("image list");
});

it("still validates complete row history rather than accepting malformed transport for image collection", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.payload));
  input.history.effectSets[0].effects[1].before.name = ["text", "changed"];
  expect(() => sharedRecoveryAssetManifest(input, f.images)).toThrow("Before image mismatch");
});
