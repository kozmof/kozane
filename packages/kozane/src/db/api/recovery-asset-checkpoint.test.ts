import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { localTableNames } from "../../../../core/src/actions/local-tables.js";
import { capturedTables } from "../../test-utils/action-tables.js";
import { describeLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery-checkpoint.js";
import { describeSharedRecoveryHistory } from "../../../../core/src/actions/shared-recovery-checkpoint.js";
import {
  describeRecoveryAssets,
  parseRecoveryAssetCheckpoint,
  parseRecoveryAssetPayload,
  requireRecoveryAssetCheckpoint,
} from "../../../../core/src/actions/recovery-asset-checkpoint.js";

const identity = {
  workspaceId: "workspace🪁",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const filename = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
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
  name: ["text", `kozane-image:/api/images/${filename(n)}`],
  is_default: ["integer", "0"],
});
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const clone = <T>(input: T): Mutable<T> => JSON.parse(JSON.stringify(input));
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const local = await describeLocalRecoverySnapshot({
    version: 1,
    rowEncodingVersion: 1,
    identity,
    selection: { baselineId: "baseline", effectSetIds: ["edit", "empty"] },
    tables: localTableNames.map((name) => ({
      name,
      rows:
        name === "local_image_upload"
          ? [
              {
                filename: ["text", filename(4)],
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
  const shared = await describeSharedRecoveryHistory(
    {
      baseline: {
        id: "baseline",
        projection: {
          version: 1,
          rowEncodingVersion: 1,
          schemaId: identity.schemaId,
          tables: capturedTables.map(({ name }) => ({
            name,
            rows: name === "namespace" ? [row(1)] : [],
          })),
        },
      },
      effectSets: [
        {
          id: "edit",
          effects: [
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
              op: "D",
              before: row(2),
              after: null,
            },
          ],
        },
        { id: "empty", effects: [] },
      ],
    },
    identity,
    {
      baselineId: "baseline",
      effectSets: [
        { id: "edit", effectCount: 2 },
        { id: "empty", effectCount: 0 },
      ],
    },
  );
  return clone({
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    history: {
      baseline: { id: "baseline", manifest: manifest(1) },
      effectSets: [
        { id: "edit", manifest: manifest(1, 2) },
        { id: "empty", manifest: manifest(3) },
      ],
    },
  });
}
async function descriptor(payload: ReturnType<typeof parseRecoveryAssetPayload>) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    version: 1,
    binding: payload.binding,
    byteLength: bytes.byteLength,
    sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
  };
}

it("binds full per-record requirements and local-only images to both exact checkpoints", async () => {
  const f = await fixture();
  const before = JSON.stringify(f);
  const result = await describeRecoveryAssets(f);
  expect(result.payload.manifest).toEqual(manifest(1, 2, 3, 4));
  expect(result.payload.history).toEqual(f.history);
  expect(result.checkpoint.binding).toEqual(f.binding);
  expect(result.checkpoint).toEqual(await descriptor(result.payload));
  expect(result.checkpoint.byteLength).toBeGreaterThan(JSON.stringify(result.payload).length);
  expect(
    await requireRecoveryAssetCheckpoint(result.payload, result.checkpoint, identity, f),
  ).toEqual(result.payload);
  expect(Object.isFrozen(result.payload.binding.localCheckpoint.selection.effectSetIds)).toBe(true);
  expect(Object.isFrozen(result.payload.history.effectSets[0].manifest.entries[0])).toBe(true);
  expect(JSON.stringify(f)).toBe(before);
});

it("canonicalizes field and manifest entry order without changing record associations", async () => {
  const f = await fixture();
  const expected = await describeRecoveryAssets(f);
  f.history.effectSets[0].manifest.entries.reverse();
  expect(await describeRecoveryAssets(f)).toEqual(expected);
  const payload = clone(expected.payload);
  const unordered = {
    manifest: { ...payload.manifest, entries: [...payload.manifest.entries].reverse() },
    history: payload.history,
    binding: {
      localCheckpoint: payload.binding.localCheckpoint,
      checkpoint: payload.binding.checkpoint,
    },
    version: payload.version,
  };
  expect(parseRecoveryAssetPayload(unordered)).toEqual(expected.payload);
  expect(await requireRecoveryAssetCheckpoint(unordered, expected.checkpoint, identity, f)).toEqual(
    expected.payload,
  );
});

it("binds invocation-only requirements even when the combined manifest stays identical", async () => {
  const f = await fixture();
  const first = await describeRecoveryAssets(f);
  f.history.baseline.manifest = manifest(1, 3);
  f.history.effectSets[1].manifest = manifest();
  const second = await describeRecoveryAssets(f);
  expect(second.payload.manifest).toEqual(first.payload.manifest);
  expect(second.checkpoint.sha256).not.toBe(first.checkpoint.sha256);
  await expect(
    requireRecoveryAssetCheckpoint(second.payload, first.checkpoint, identity, f),
  ).rejects.toThrow("content mismatch");
});

it.each(["remove-extra", "add-extra", "hash", "length"])(
  "refuses %s changes to a previously bound manifest",
  async (change) => {
    const f = await fixture();
    const first = await describeRecoveryAssets(f);
    if (change === "remove-extra") f.history.effectSets[1].manifest = manifest();
    if (change === "add-extra") f.history.effectSets[1].manifest = manifest(3, 5);
    if (change === "hash") f.history.effectSets[1].manifest.entries[0].sha256 = "b".repeat(64);
    if (change === "length") f.history.effectSets[1].manifest.entries[0].byteLength = 4;
    const second = await describeRecoveryAssets(f);
    await expect(
      requireRecoveryAssetCheckpoint(second.payload, first.checkpoint, identity, f),
    ).rejects.toThrow("content mismatch");
  },
);

it.each(["local", "shared"])(
  "refuses a different %s source with identical identity and selection",
  async (area) => {
    const f = await fixture();
    const result = await describeRecoveryAssets(f);
    const changed = clone(f);
    if (area === "local")
      changed.localSnapshot.tables.find(
        ({ name }) => name === "local_image_upload",
      )!.rows[0].created_at = ["integer", "2"];
    else {
      changed.sharedHistory.history.effectSets[0].effects[0].after!.name = [
        "text",
        `kozane-image:/api/images/${filename(1)}`,
      ];
      changed.sharedHistory.history.effectSets[0].effects[1].before!.name = [
        "text",
        `kozane-image:/api/images/${filename(1)}`,
      ];
    }
    await expect(describeRecoveryAssets(changed)).rejects.toThrow();
    await expect(
      requireRecoveryAssetCheckpoint(result.payload, result.checkpoint, identity, changed),
    ).rejects.toThrow();
  },
);

it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "refuses another expected %s before hashing",
  async (field) => {
    const f = await fixture();
    const result = await describeRecoveryAssets(f);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const changed = {
      ...identity,
      [field]: field === "schemaId" ? migrations.at(-2)!.id : "another",
    };
    await expect(
      requireRecoveryAssetCheckpoint(result.payload, result.checkpoint, changed, f),
    ).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);

it.each(["local-hash", "shared-hash", "count", "order", "local-identity"])(
  "refuses %s binding changes",
  async (change) => {
    const f = await fixture();
    const result = await describeRecoveryAssets(f);
    const altered = clone(result.payload);
    if (change === "local-hash")
      altered.binding.localCheckpoint = {
        ...altered.binding.localCheckpoint,
        sha256: "b".repeat(64),
      };
    if (change === "shared-hash")
      altered.binding.checkpoint = { ...altered.binding.checkpoint, sha256: "b".repeat(64) };
    if (change === "count")
      altered.binding.checkpoint.selection.effectSets[0] = { id: "edit", effectCount: 1 };
    if (change === "order")
      altered.binding.localCheckpoint.selection = {
        ...altered.binding.localCheckpoint.selection,
        effectSetIds: ["empty", "edit"],
      };
    if (change === "local-identity")
      altered.binding.localCheckpoint = {
        ...altered.binding.localCheckpoint,
        identity: { ...identity, deviceId: "other" },
      };
    await expect(
      requireRecoveryAssetCheckpoint(altered, result.checkpoint, identity, f),
    ).rejects.toThrow("binding mismatch");
  },
);

it.each(["missing-local", "extra-local", "missing-row"])(
  "checks %s coverage even with a matching independently supplied asset digest",
  async (change) => {
    const f = await fixture();
    const result = await describeRecoveryAssets(f);
    const input = { ...clone(result.payload), manifest: manifest(1, 2, 3) };
    if (change === "extra-local") input.manifest = manifest(1, 2, 3, 4, 5);
    if (change === "missing-row")
      input.history = {
        ...input.history,
        effectSets: [{ id: "edit", manifest: manifest(1) }, input.history.effectSets[1]],
      };
    const payload = parseRecoveryAssetPayload(input);
    await expect(
      requireRecoveryAssetCheckpoint(payload, await descriptor(payload), identity, f),
    ).rejects.toThrow(
      change === "missing-row" ? "Required asset is missing" : "requirements mismatch",
    );
  },
);

it("refuses a combined manifest that omits supplied invocation-only requirements", async () => {
  const result = await describeRecoveryAssets(await fixture());
  expect(() =>
    parseRecoveryAssetPayload({ ...result.payload, manifest: manifest(1, 2, 4) }),
  ).toThrow("omits history requirements");
});

it.each(["payload", "checkpoint", "binding", "history"])(
  "rejects %s getters without invoking them",
  async (area) => {
    const f = await fixture();
    const result = await describeRecoveryAssets(f);
    const getter = vi.fn(() => result.payload.history);
    const input = clone(area === "checkpoint" ? result.checkpoint : result.payload);
    const target =
      area === "binding"
        ? input.binding
        : area === "history"
          ? (input as typeof result.payload).history
          : input;
    const field =
      area === "binding"
        ? "checkpoint"
        : area === "history"
          ? "baseline"
          : area === "checkpoint"
            ? "sha256"
            : "history";
    Object.defineProperty(target, field, { enumerable: true, get: getter });
    expect(() =>
      area === "checkpoint"
        ? parseRecoveryAssetCheckpoint(input)
        : parseRecoveryAssetPayload(input),
    ).toThrow("plain");
    expect(getter).not.toHaveBeenCalled();
  },
);

it.each(["version", "length", "hash", "extra"])(
  "refuses malformed descriptor %s",
  async (change) => {
    const result = await describeRecoveryAssets(await fixture());
    const input = { ...result.checkpoint } as Record<string, unknown>;
    if (change === "version") input.version = 2;
    if (change === "length") input.byteLength = Number.MAX_SAFE_INTEGER + 1;
    if (change === "hash") input.sha256 = result.checkpoint.sha256 + "\n";
    if (change === "extra") input.extra = true;
    expect(() => parseRecoveryAssetCheckpoint(input)).toThrow();
  },
);

it("reads historical descriptors as metadata but refuses historical payload preparation", async () => {
  const result = await describeRecoveryAssets(await fixture());
  const old = clone(result.checkpoint);
  const schemaId = migrations.at(-2)!.id;
  const binding = {
    checkpoint: { ...old.binding.checkpoint, identity: { ...identity, schemaId } },
    localCheckpoint: { ...old.binding.localCheckpoint, identity: { ...identity, schemaId } },
  };
  expect(parseRecoveryAssetCheckpoint({ ...old, binding }).binding).toEqual(binding);
  expect(() => parseRecoveryAssetPayload({ ...result.payload, binding })).toThrow(
    "Unsupported local recovery schema",
  );
  expect(() =>
    parseRecoveryAssetCheckpoint({
      ...old,
      binding: {
        ...binding,
        checkpoint: { ...binding.checkpoint, identity: { ...identity, schemaId: "unknown" } },
      },
    }),
  ).toThrow();
});

it.each(["description", "verification"])(
  "owns every input before hashing during %s",
  async (stage) => {
    const f = await fixture();
    const original = await describeRecoveryAssets(f);
    const payload = clone(original.payload);
    const checkpoint = clone(original.checkpoint);
    const expected = { ...identity };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      f.history.effectSets.reverse();
      f.binding.localCheckpoint = { ...f.binding.localCheckpoint, sha256: "b".repeat(64) };
      f.localSnapshot.tables.find(({ name }) => name === "local_image_upload")!.rows[0].created_at =
        ["integer", "2"];
      f.sharedHistory.history.baseline.projection.tables.find(
        ({ name }) => name === "namespace",
      )!.rows[0].name = ["text", "changed"];
      checkpoint.binding.checkpoint = { ...checkpoint.binding.checkpoint, sha256: "b".repeat(64) };
      payload.history.effectSets.reverse();
      expected.deviceId = "changed";
      return digest(...args);
    });
    const result =
      stage === "description"
        ? (await describeRecoveryAssets(f)).payload
        : await requireRecoveryAssetCheckpoint(payload, checkpoint, expected, f);
    expect(result).toEqual(original.payload);
  },
);
