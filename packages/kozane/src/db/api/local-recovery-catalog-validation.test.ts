import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import type { DB } from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import {
  captureLocalRecoveryCheckpoint,
  describeLocalRecoverySnapshot,
} from "../../../../core/src/actions/local-recovery-checkpoint.js";
import {
  rememberLocalRecoveryCheckpoint,
  inspectLocalRecoveryCheckpoint,
} from "../../../../core/src/actions/local-recovery-store.js";
import { validateStoredLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-validation.js";
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const database = async () => (await createTestDB()) as unknown as DB;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
const selection = { baselineId: "baseline", effectSetIds: ["origin-a", "origin-b"] };
async function fixture(register = true) {
  const source = await database();
  await source.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/original','workspace_relative',9007199254740993)`,
  );
  const captured = await captureLocalRecoveryCheckpoint(source, identity, async () => selection);
  if (register) await rememberLocalRecoveryCheckpoint(source, captured.checkpoint);
  const target = await database();
  const create = vi.fn(async () => target);
  const validate = (input: unknown = captured.snapshot) =>
    validateStoredLocalRecoveryCheckpoint(source, create, input, identity);
  const emptyTarget = async () => {
    expect(await target.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM local_recovery_checkpoint`)).toEqual([]);
  };
  return { source, target, create, validate, emptyTarget, ...captured };
}

it("validates against the retained catalog descriptor without copying source registration into the target", async () => {
  const f = await fixture();
  const before = await f.source.values(sql`SELECT * FROM local_recovery_checkpoint`);
  expect(await f.validate()).toEqual(f.snapshot);
  expect(f.create).toHaveBeenCalledTimes(1);
  await f.emptyTarget();
  expect(await f.source.values(sql`SELECT * FROM local_recovery_checkpoint`)).toEqual(before);
  expect(await inspectLocalRecoveryCheckpoint(f.source, key)).toEqual(f.checkpoint);
});

it.each([false, true])(
  "refuses unregistered expectations, including catalog records inside transport (embedded=%s)",
  async (embedded) => {
    const f = await fixture(false);
    const snapshot = embedded
      ? {
          ...f.snapshot,
          tables: f.snapshot.tables.map((table) =>
            table.name === "local_recovery_checkpoint"
              ? {
                  ...table,
                  rows: [
                    {
                      workspace_id: ["text", key.workspaceId],
                      device_id: ["text", key.deviceId],
                      epoch_id: ["text", key.epochId],
                      checkpoint_id: ["text", key.checkpointId],
                      descriptor: ["text", JSON.stringify(f.checkpoint)],
                      created_at: ["integer", "1"],
                    },
                  ],
                }
              : table,
          ),
        }
      : f.snapshot;
    await expect(f.validate(snapshot)).rejects.toThrow("not registered");
    expect(f.create).not.toHaveBeenCalled();
    expect(await inspectLocalRecoveryCheckpoint(f.source, key)).toBeNull();
    await f.emptyTarget();
  },
);

it.each(["content", "selection", "identity"] as const)(
  "refuses changed %s before validation allocation",
  async (field) => {
    const f = await fixture();
    const snapshot = JSON.parse(JSON.stringify(f.snapshot));
    if (field === "content")
      snapshot.tables.find(
        (table: { name: string }) => table.name === "taskspace_local",
      ).rows[0].path = ["text", "local/modified"];
    if (field === "selection") snapshot.selection.effectSetIds.reverse();
    if (field === "identity") snapshot.identity.deviceId = "other";
    await expect(f.validate(snapshot)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
    expect(await inspectLocalRecoveryCheckpoint(f.source, key)).toEqual(f.checkpoint);
  },
);

it.each(["removed", "replaced"] as const)(
  "refuses a %s catalog binding during isolated validation",
  async (change) => {
    const f = await fixture();
    const factory = vi.fn(async () => {
      if (change === "removed") await f.source.run(sql`DELETE FROM local_recovery_checkpoint`);
      else
        await f.source.run(
          sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...f.checkpoint, sha256: "b".repeat(64) })}`,
        );
      return f.target;
    });
    await expect(
      validateStoredLocalRecoveryCheckpoint(f.source, factory, f.snapshot, identity),
    ).rejects.toThrow("changed during validation");
    expect(factory).toHaveBeenCalledTimes(1);
    await f.emptyTarget();
  },
);

it("permits unrelated catalog registrations and normalizes equivalent descriptor JSON during validation", async () => {
  const f = await fixture();
  const result = await validateStoredLocalRecoveryCheckpoint(
    f.source,
    async () => {
      // No catalog read transaction remains open while the host allocates its isolated database.
      await rememberLocalRecoveryCheckpoint(f.source, {
        ...f.checkpoint,
        identity: { ...identity, checkpointId: "later" },
      });
      await f.source.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(f.checkpoint, null, 2)} WHERE checkpoint_id=${key.checkpointId}`,
      );
      return f.target;
    },
    f.snapshot,
    identity,
  );
  expect(result).toEqual(f.snapshot);
  expect(await inspectLocalRecoveryCheckpoint(f.source, key)).toEqual(f.checkpoint);
  expect(
    await inspectLocalRecoveryCheckpoint(f.source, { ...key, checkpointId: "later" }),
  ).not.toBeNull();
  await f.emptyTarget();
});

it("owns snapshot and expected identity before asynchronous catalog reads", async () => {
  const f = await fixture();
  const snapshot = JSON.parse(JSON.stringify(f.snapshot));
  const expected = { ...identity };
  const pending = validateStoredLocalRecoveryCheckpoint(f.source, f.create, snapshot, expected);
  snapshot.tables.length = 0;
  snapshot.identity.deviceId = "other";
  expected.deviceId = "other";
  expect(await pending).toEqual(f.snapshot);
  await f.emptyTarget();
});

it("refuses malformed retained metadata without opening a validation database", async () => {
  const f = await fixture();
  await f.source.run(
    sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...f.checkpoint, sha256: "bad" })}`,
  );
  await expect(f.validate()).rejects.toThrow();
  expect(f.create).not.toHaveBeenCalled();
  await f.emptyTarget();
});

it("retains historical metadata without authorizing incompatible snapshot validation", async () => {
  const f = await fixture(false);
  await rememberLocalRecoveryCheckpoint(f.source, {
    ...f.checkpoint,
    identity: { ...identity, schemaId: "0026_local_asset_manifest" },
  });
  await expect(f.validate()).rejects.toThrow("identity mismatch");
  expect(f.create).not.toHaveBeenCalled();
});

it("still enforces SQL read-back after a matching stored descriptor is verified", async () => {
  const f = await fixture(false);
  const snapshot = {
    ...f.snapshot,
    tables: f.snapshot.tables.map((table) =>
      table.name === "taskspace_local"
        ? {
            ...table,
            rows: table.rows.map((row) => ({ ...row, last_seen_at: ["real", "3ff0000000000000"] })),
          }
        : table,
    ),
  };
  const described = await describeLocalRecoverySnapshot(snapshot);
  await rememberLocalRecoveryCheckpoint(f.source, described.checkpoint);
  await expect(f.validate(described.snapshot)).rejects.toThrow("differs from projection");
  await f.emptyTarget();
});
