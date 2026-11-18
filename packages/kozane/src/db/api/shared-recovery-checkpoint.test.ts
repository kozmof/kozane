import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { capturedTables, captureApplicationRows } from "../../test-utils/action-tables.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import {
  parseSharedRecoveryProjection,
  type SharedRecoveryEffect,
} from "../../../../core/src/actions/shared-recovery.js";
import {
  describeSharedRecoveryHistory,
  parseSharedRecoveryCheckpoint,
  parseSharedRecoveryHistoryPayload,
  requireSharedRecoveryCheckpoint,
  validateSharedRecoveryCheckpoint,
} from "../../../../core/src/actions/shared-recovery-checkpoint.js";
import type { DB } from "../../../../core/src/database.js";
import type { TaggedRow } from "../../../../core/src/actions/row-codec.js";
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const identity = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const selection = {
  baselineId: "baseline",
  effectSets: [
    { id: "first", effectCount: 2 },
    { id: "empty", effectCount: 0 },
  ],
};
const initial = '\ufeff{"text":"start"}\0🪁';
const namespace = (name: string): TaggedRow => ({
  id: ["text", "n"],
  name: ["text", name],
  is_default: ["integer", "0"],
});
const warp: TaggedRow = {
  id: ["text", "w"],
  namespace_id: ["text", "n"],
  pos_x: ["integer", "9007199254740993"],
  pos_y: ["real", "3ff8000000000000"],
};
const update = (ord: number, before: string, after: string): SharedRecoveryEffect => ({
  ord,
  table: "namespace",
  key: { id: ["text", "n"] },
  op: "U",
  before: namespace(before),
  after: namespace(after),
});
async function fixture() {
  const baseline = parseSharedRecoveryProjection({
    version: 1,
    rowEncodingVersion: 1,
    schemaId: identity.schemaId,
    tables: capturedTables.map(({ name }) => ({
      name,
      rows: name === "namespace" ? [namespace(initial)] : name === "warp" ? [warp] : [],
    })),
  });
  return describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection: baseline },
      effectSets: [
        { id: "first", effects: [update(0, initial, "middle"), update(1, "middle", "final")] },
        { id: "empty", effects: [] },
      ],
    },
    identity,
    selection,
  );
}
const database = async () => (await createTestDB()) as unknown as DB;
// Retain earlier schema vectors when adding new bundled migrations.
const vectors: Record<string, { byteLength: number; sha256: string }> = {
  "0033_local_recovery_retained_assets": {
    byteLength: 1560,
    sha256: "143decb30f0e3948af5a97681837ae061bcd1309510adb7c57533f26f6db43e8",
  },
  "0032_local_recovery_retained_history": {
    byteLength: 1562,
    sha256: "70236052c6f9d3574c8ab454c02f4438b31cbe3ca495b7e6775d61cae556829f",
  },
  "0031_local_recovery_actions": {
    byteLength: 1544,
    sha256: "6cd063a3101873fb0dac3e4a407ee9b9064934c9f9d2286e00b33bbbbd080013",
  },
  "0030_local_recovery_executions": {
    byteLength: 1550,
    sha256: "82535f2f9c3439745f67dc5b3d4f5eb430aeb1f338ccee0748c0443a42dc4ac9",
  },
  "0029_local_recovery_assets": {
    byteLength: 1542,
    sha256: "7f2a24221dc64de32005226cbc9b0cfab594fd369c4f39828a37999ea4993a2b",
  },
  "0028_local_recovery_shared_history": {
    byteLength: 1558,
    sha256: "c67097fa38b45d28d1118691927f6a6d043d149950265c727a44db14c67d0f76",
  },
  "0027_local_recovery_checkpoint": {
    byteLength: 1550,
    sha256: "5284c3f1e170922a488ab27148e8eaae9e925fd445635a938448f8d4302c04fe",
  },
};

it("binds canonical UTF-8 history bytes, counts and checkpoint identity to an independent SHA-256 vector", async () => {
  const f = await fixture();
  expect(f.checkpoint).toEqual({ version: 1, identity, selection, ...vectors[identity.schemaId] });
  const json = JSON.stringify(f.payload);
  expect(f.checkpoint.byteLength).toBeGreaterThan(json.length);
  expect(f.checkpoint.byteLength).toBe(new TextEncoder().encode(json).byteLength);
  expect(Object.isFrozen(f.checkpoint.selection.effectSets[0])).toBe(true);
  expect(Object.isFrozen(f.payload.history.effectSets[0].effects[0].before)).toBe(true);
  expect(await requireSharedRecoveryCheckpoint(f.payload, f.checkpoint, identity)).toEqual({
    payload: f.payload,
    projection: f.projection,
  });
});

it("canonicalizes field, table, row, column and transported record ordering without changing selection order", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.payload, null, 4));
  input.history.effectSets.reverse();
  input.history.baseline.projection.tables.reverse();
  const reverse = (row: object) => Object.fromEntries(Object.entries(row).reverse());
  for (const table of input.history.baseline.projection.tables)
    table.rows = table.rows.reverse().map(reverse);
  for (const set of input.history.effectSets)
    for (const effect of set.effects) {
      effect.key = reverse(effect.key);
      if (effect.before !== null) effect.before = reverse(effect.before);
      if (effect.after !== null) effect.after = reverse(effect.after);
    }
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  expect(parseSharedRecoveryHistoryPayload(reordered)).toEqual(f.payload);
  expect(await requireSharedRecoveryCheckpoint(reordered, f.checkpoint, identity)).toEqual({
    payload: f.payload,
    projection: f.projection,
  });
});

it("binds intermediate effects even when histories have the same final projection and byte length", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.payload));
  input.history.effectSets[0].effects[0].after.name = ["text", "meddle"];
  input.history.effectSets[0].effects[1].before.name = ["text", "meddle"];
  const other = await describeSharedRecoveryHistory(input.history, identity, selection);
  expect(other.projection).toEqual(f.projection);
  expect(other.checkpoint.byteLength).toBe(f.checkpoint.byteLength);
  expect(other.checkpoint.sha256).not.toBe(f.checkpoint.sha256);
  await expect(requireSharedRecoveryCheckpoint(input, f.checkpoint, identity)).rejects.toThrow(
    "content mismatch",
  );
});

it("preserves exact TEXT cells instead of reformatting embedded JSON", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.payload));
  const changed = '\ufeff{ "text": "start" }\0🪁';
  input.history.baseline.projection.tables.find(
    (table: { name: string }) => table.name === "namespace",
  ).rows[0].name = ["text", changed];
  input.history.effectSets[0].effects[0].before.name = ["text", changed];
  const other = await describeSharedRecoveryHistory(input.history, identity, selection);
  expect(other.projection).toEqual(f.projection);
  expect(other.checkpoint.sha256).not.toBe(f.checkpoint.sha256);
  await expect(requireSharedRecoveryCheckpoint(input, f.checkpoint, identity)).rejects.toThrow(
    "content mismatch",
  );
});

it.each(["unsafe-integer", "storage-class", "real-bits"])(
  "refuses changed %s cells before allocating SQL validation",
  async (change) => {
    const f = await fixture();
    const input = JSON.parse(JSON.stringify(f.payload));
    const row = input.history.baseline.projection.tables.find(
      (table: { name: string }) => table.name === "warp",
    ).rows[0];
    if (change === "unsafe-integer") row.pos_x = ["integer", "9007199254740992"];
    if (change === "storage-class") row.pos_y = ["text", "1.5"];
    if (change === "real-bits") row.pos_y = ["real", "8000000000000000"];
    const create = vi.fn(database);
    await expect(
      validateSharedRecoveryCheckpoint(create, input, f.checkpoint, identity),
    ).rejects.toThrow("content mismatch");
    expect(create).not.toHaveBeenCalled();
  },
);

it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "refuses mismatched host %s before hashing or allocating SQL validation",
  async (field) => {
    const f = await fixture();
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const create = vi.fn(database);
    await expect(
      validateSharedRecoveryCheckpoint(create, f.payload, f.checkpoint, {
        ...identity,
        [field]: "other",
      }),
    ).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each(["count", "order", "descriptor-identity"])(
  "refuses mismatched %s metadata before hashing",
  async (change) => {
    const f = await fixture();
    const checkpoint = JSON.parse(JSON.stringify(f.checkpoint));
    if (change === "count") checkpoint.selection.effectSets[0].effectCount = 1;
    if (change === "order") checkpoint.selection.effectSets.reverse();
    if (change === "descriptor-identity") checkpoint.identity.deviceId = "other";
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const create = vi.fn(database);
    await expect(
      validateSharedRecoveryCheckpoint(create, f.payload, checkpoint, identity),
    ).rejects.toThrow("mismatch");
    expect(digest).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each(["length", "hash"])(
  "refuses a changed descriptor %s before SQL validation",
  async (change) => {
    const f = await fixture();
    const checkpoint = {
      ...f.checkpoint,
      ...(change === "length"
        ? { byteLength: f.checkpoint.byteLength + 1 }
        : { sha256: "b".repeat(64) }),
    };
    const create = vi.fn(database);
    await expect(
      validateSharedRecoveryCheckpoint(create, f.payload, checkpoint, identity),
    ).rejects.toThrow("content mismatch");
    expect(create).not.toHaveBeenCalled();
  },
);

it("retains historical descriptor metadata without authorizing old-schema history loading", async () => {
  const f = await fixture();
  const historical = { ...identity, schemaId: migrations.at(-2)!.id };
  const checkpoint = { ...f.checkpoint, identity: historical };
  expect(parseSharedRecoveryCheckpoint(checkpoint).identity).toEqual(historical);
  const create = vi.fn(database);
  await expect(
    validateSharedRecoveryCheckpoint(create, f.payload, checkpoint, historical),
  ).rejects.toThrow("Unsupported local recovery schema");
  expect(create).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid descriptor byte length %s",
  async (byteLength) => {
    const f = await fixture();
    expect(() => parseSharedRecoveryCheckpoint({ ...f.checkpoint, byteLength })).toThrow();
  },
);

it("refuses malformed and accessor metadata without invoking hooks", async () => {
  const f = await fixture();
  const getter = vi.fn(() => f.checkpoint.sha256);
  const checkpoint = { ...f.checkpoint };
  Object.defineProperty(checkpoint, "sha256", { enumerable: true, get: getter });
  expect(() => parseSharedRecoveryCheckpoint(checkpoint)).toThrow("plain data");
  expect(getter).not.toHaveBeenCalled();
  const serialize = vi.fn(() => f.payload);
  expect(() => parseSharedRecoveryHistoryPayload({ ...f.payload, toJSON: serialize })).toThrow();
  expect(serialize).not.toHaveBeenCalled();
  await expect(
    describeSharedRecoveryHistory({ ...f.payload.history, effectSets: [] }, identity, selection),
  ).rejects.toThrow("Missing selected");
});

it("owns creation inputs and context before awaiting the digest", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.payload));
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(async (algorithm, bytes) => {
    input.identity.deviceId = "changed";
    input.selection.effectSets[0].effectCount = 0;
    input.history.effectSets.length = 0;
    return digest(algorithm, bytes);
  });
  expect(
    await describeSharedRecoveryHistory(input.history, input.identity, input.selection),
  ).toEqual(f);
});

it("owns received payload, trusted descriptor and expected identity while hashing", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.payload));
  const checkpoint = JSON.parse(JSON.stringify(f.checkpoint));
  const expected = { ...identity };
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(async (algorithm, bytes) => {
    input.history.effectSets.length = 0;
    checkpoint.sha256 = "b".repeat(64);
    checkpoint.selection.effectSets.reverse();
    expected.deviceId = "changed";
    return digest(algorithm, bytes);
  });
  expect(await requireSharedRecoveryCheckpoint(input, checkpoint, expected)).toEqual({
    payload: f.payload,
    projection: f.projection,
  });
});

it("validates a hash-bound projection with exact SQL read-back and leaves the validation database unchanged", async () => {
  const f = await fixture();
  const target = await database();
  const schema = await target.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`);
  const create = vi.fn(async () => target);
  expect(await validateSharedRecoveryCheckpoint(create, f.payload, f.checkpoint, identity)).toEqual(
    { payload: f.payload, projection: f.projection },
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(await captureApplicationRows(target)).toEqual([]);
  expect(await target.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`)).toEqual(
    schema,
  );
});

it("still refuses SQL affinity changes when the history digest matches", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.payload));
  input.history.baseline.projection.tables.find(
    (table: { name: string }) => table.name === "warp",
  ).rows[0].pos_y = ["real", "3ff0000000000000"];
  const described = await describeSharedRecoveryHistory(input.history, identity, selection);
  const target = await database();
  const create = vi.fn(async () => target);
  await expect(
    validateSharedRecoveryCheckpoint(create, described.payload, described.checkpoint, identity),
  ).rejects.toThrow("differs from projection");
  expect(create).toHaveBeenCalledTimes(1);
  expect(await captureApplicationRows(target)).toEqual([]);
});

it("propagates validation factory failure after successful content binding", async () => {
  const f = await fixture();
  await expect(
    validateSharedRecoveryCheckpoint(
      async () => {
        throw new Error("Factory failed");
      },
      f.payload,
      f.checkpoint,
      identity,
    ),
  ).rejects.toThrow("Factory failed");
});
