import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  createDatabaseAdapter,
  withReadTx,
  type DB,
  type DatabaseHandle,
} from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { captureLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery.js";
import {
  describeLocalRecoverySnapshot,
  captureLocalRecoveryCheckpoint,
  parseLocalRecoveryCheckpoint,
  requireLocalRecoveryCheckpoint,
} from "../../../../core/src/actions/local-recovery-checkpoint.js";
import { validateLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-validation.js";
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const keys = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const selected = { baselineId: "baseline", effectSetIds: ["origin-a", "origin-b"] };
// Independently hashed canonical vectors. Retain older records when the bundled schema changes.
const vectors: Record<string, { byteLength: number; sha256: string }> = {
  "0028_local_recovery_shared_history": {
    byteLength: 697,
    sha256: "0b30b6a760ef901e3402f87ac551c6329c44ddc6933a9c463bc9d2b7dbad7a7c",
  },
  "0026_local_asset_manifest": {
    byteLength: 590,
    sha256: "194455915db1be514ac518761ea21f4820f4845a5785b4491de53cea794e3b2d",
  },
  "0027_local_recovery_checkpoint": {
    byteLength: 642,
    sha256: "18d0c689f6f59bc991bc55e0a0d594844f0f3bb6476a63efd53e0462d114ddde",
  },
};
async function fixture() {
  const source = (await createTestDB()) as unknown as DB;
  await source.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/🪁' || char(0) || 'file','workspace_relative',9007199254740993)`,
  );
  const snapshot = await captureLocalRecoverySnapshot(source, keys, async () => selected);
  const described = await describeLocalRecoverySnapshot(snapshot);
  return { source, ...described };
}

it("binds canonical UTF-8 snapshot bytes to a SHA-256 descriptor", async () => {
  const f = await fixture();
  const canonical = JSON.stringify(f.snapshot);
  expect(f.checkpoint).toEqual({
    version: 1,
    identity: keys,
    selection: selected,
    ...vectors[keys.schemaId],
  });
  expect(f.checkpoint.byteLength).toBeGreaterThan(canonical.length);
  expect(f.checkpoint.byteLength).toBe(new TextEncoder().encode(canonical).byteLength);
  expect(Object.isFrozen(f.checkpoint)).toBe(true);
  expect(Object.isFrozen(f.checkpoint.selection.effectSetIds)).toBe(true);
  expect(await requireLocalRecoveryCheckpoint(f.snapshot, f.checkpoint)).toEqual(f.snapshot);
});

it("ignores incoming JSON whitespace, field order, table order and row order", async () => {
  const f = await fixture();
  await f.source.run(
    sql`INSERT INTO taskspace_local VALUES('second','local/second','workspace_relative',0)`,
  );
  const snapshot = await captureLocalRecoverySnapshot(f.source, keys, async () => selected);
  const expected = await describeLocalRecoverySnapshot(snapshot);
  const input = JSON.parse(JSON.stringify(snapshot, null, 4));
  input.tables.reverse();
  for (const table of input.tables) {
    table.rows.reverse();
    table.rows = table.rows.map((row: object) => Object.fromEntries(Object.entries(row).reverse()));
  }
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  expect(await describeLocalRecoverySnapshot(reordered)).toEqual(expected);
});

it("captures selections and rows in one read boundary and hashes only after it closes", async () => {
  const f = await fixture();
  let active = false;
  let reads = 0;
  const db = createDatabaseAdapter(new Proxy(f.source, {}), {
    write: async () => {
      throw new Error("Unexpected write");
    },
    read: (operation) =>
      withReadTx(f.source, async (tx) => {
        reads++;
        active = true;
        try {
          return await operation(tx as unknown as DatabaseHandle);
        } finally {
          active = false;
        }
      }),
  });
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce((algorithm, bytes) => {
    expect(active).toBe(false);
    return digest(algorithm, bytes);
  });
  const captured = await captureLocalRecoveryCheckpoint(db, keys, async (tx) => {
    expect(active).toBe(true);
    expect((await tx.values(sql`SELECT taskspace_id FROM taskspace_local`))[0][0]).toBe("absent");
    return selected;
  });
  expect(reads).toBe(1);
  expect(captured).toEqual({ snapshot: f.snapshot, checkpoint: f.checkpoint });
});

it.each(["same-length-content", "extra-row", "integer-value", "blob-storage-class"] as const)(
  "refuses a %s change under an unchanged descriptor before database allocation",
  async (change) => {
    const f = await fixture();
    const input = JSON.parse(JSON.stringify(f.snapshot));
    const rows = input.tables.find(
      (table: { name: string }) => table.name === "taskspace_local",
    ).rows;
    if (change === "same-length-content") rows[0].path = ["text", "local/🪁\0fyle"];
    if (change === "extra-row") rows.push({ ...rows[0], taskspace_id: ["text", "second"] });
    if (change === "integer-value") rows[0].last_seen_at = ["integer", "9007199254740995"];
    if (change === "blob-storage-class") rows[0].path = ["blob", "616263"];
    const create = vi.fn(async () => (await createTestDB()) as unknown as DB);
    await expect(
      validateLocalRecoveryCheckpoint(create, input, f.checkpoint, keys),
    ).rejects.toThrow("content mismatch");
    expect(create).not.toHaveBeenCalled();
    expect(await captureLocalRecoverySnapshot(f.source, keys, async () => selected)).toEqual(
      f.snapshot,
    );
  },
);

it.each(["identity", "baseline", "materialization-order"] as const)(
  "refuses a changed %s before hashing or database allocation",
  async (change) => {
    const f = await fixture();
    const input = JSON.parse(JSON.stringify(f.snapshot));
    if (change === "identity") input.identity.checkpointId = "other";
    if (change === "baseline") input.selection.baselineId = "other";
    if (change === "materialization-order") input.selection.effectSetIds.reverse();
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const create = vi.fn(async () => (await createTestDB()) as unknown as DB);
    await expect(
      validateLocalRecoveryCheckpoint(create, input, f.checkpoint, keys),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
  },
);

it("runs SQL validation only after descriptor verification and leaves temporary rows empty", async () => {
  const f = await fixture();
  const target = (await createTestDB()) as unknown as DB;
  const create = vi.fn(async () => target);
  expect(await validateLocalRecoveryCheckpoint(create, f.snapshot, f.checkpoint, keys)).toEqual(
    f.snapshot,
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(await target.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
});

it.each(["byteLength", "sha256"] as const)(
  "refuses a well-formed but mismatched expected %s before database allocation",
  async (field) => {
    const f = await fixture();
    const checkpoint = {
      ...f.checkpoint,
      [field]: field === "sha256" ? "b".repeat(64) : f.checkpoint.byteLength + 1,
    };
    const create = vi.fn(async () => (await createTestDB()) as unknown as DB);
    await expect(
      validateLocalRecoveryCheckpoint(create, f.snapshot, checkpoint, keys),
    ).rejects.toThrow("content mismatch");
    expect(create).not.toHaveBeenCalled();
  },
);

it("does not treat a matching descriptor as SQL validation", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.snapshot));
  input.tables.find(
    (table: { name: string }) => table.name === "taskspace_local",
  ).rows[0].last_seen_at = ["real", "3ff0000000000000"];
  const described = await describeLocalRecoverySnapshot(input);
  await expect(
    validateLocalRecoveryCheckpoint(
      async () => (await createTestDB()) as unknown as DB,
      described.snapshot,
      described.checkpoint,
      keys,
    ),
  ).rejects.toThrow("differs from projection");
});

it("owns both snapshot and expected descriptor while hashing is pending", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.snapshot));
  const expected = JSON.parse(JSON.stringify(f.checkpoint));
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(async (algorithm, bytes) => {
    input.tables.length = 0;
    expected.sha256 = "b".repeat(64);
    expected.selection.effectSetIds.reverse();
    return digest(algorithm, bytes);
  });
  expect(await requireLocalRecoveryCheckpoint(input, expected)).toEqual(f.snapshot);
});

it("preserves exact TEXT cells even when their contents are equivalent JSON", async () => {
  const f = await fixture();
  await f.source.run(
    sql`INSERT INTO local_asset_manifest(owner_kind,owner_id,manifest,state,created_at) VALUES('recovery','owner','{"version":1,"entries":[]}','pending',0)`,
  );
  const before = await captureLocalRecoveryCheckpoint(f.source, keys, async () => selected);
  await f.source.run(sql`UPDATE local_asset_manifest SET manifest='{"entries": [], "version": 1}'`);
  const after = await captureLocalRecoveryCheckpoint(f.source, keys, async () => selected);
  expect(after.checkpoint.sha256).not.toBe(before.checkpoint.sha256);
  await expect(requireLocalRecoveryCheckpoint(after.snapshot, before.checkpoint)).rejects.toThrow(
    "content mismatch",
  );
});

it.each([
  { version: 2 },
  { byteLength: 0 },
  { byteLength: 1.5 },
  { byteLength: Number.MAX_SAFE_INTEGER + 1 },
  { sha256: "a".repeat(64) + "\n" },
  { sha256: "A".repeat(64) },
  { sha256: "bad" },
])("refuses malformed descriptor fields %# before database allocation", async (fields) => {
  const f = await fixture();
  const value = { ...f.checkpoint, ...fields };
  expect(() => parseLocalRecoveryCheckpoint(value)).toThrow();
  const create = vi.fn(async () => (await createTestDB()) as unknown as DB);
  await expect(validateLocalRecoveryCheckpoint(create, f.snapshot, value, keys)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it("refuses descriptor accessors and serialization hooks without invoking them", async () => {
  const f = await fixture();
  const hook = vi.fn();
  const getter = Object.defineProperty({ ...f.checkpoint }, "sha256", {
    enumerable: true,
    get: hook,
  });
  expect(() => parseLocalRecoveryCheckpoint(getter)).toThrow();
  expect(() => parseLocalRecoveryCheckpoint({ ...f.checkpoint, toJSON: hook })).toThrow();
  expect(hook).not.toHaveBeenCalled();
});

it("propagates hash failures before calling the database factory", async () => {
  const f = await fixture();
  vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(new Error("Hash unavailable"));
  const create = vi.fn(async () => (await createTestDB()) as unknown as DB);
  await expect(
    validateLocalRecoveryCheckpoint(create, f.snapshot, f.checkpoint, keys),
  ).rejects.toThrow("Hash unavailable");
  expect(create).not.toHaveBeenCalled();
});
