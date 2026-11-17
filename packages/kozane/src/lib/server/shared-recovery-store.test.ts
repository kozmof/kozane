import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrations } from "@kozane/core/migrations";
import { withTx } from "@kozane/core/database";
import {
  rememberLocalRecoveryCheckpoint,
  rememberSharedRecoveryCheckpoint,
  rememberSharedRecoveryCheckpointInTx,
  inspectSharedRecoveryCheckpoint,
} from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "kozane-shared-catalog-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it("serializes shared registration and local removal across connections and reopens the committed binding", async () => {
  const path = join(root, "db.sqlite");
  const db = await createTestDB(path);
  const key = {
    workspaceId: "workspace",
    deviceId: "device",
    epochId: "epoch",
    checkpointId: "checkpoint",
  };
  const identity = { ...key, schemaId: migrations.at(-1)!.id };
  const local = {
    version: 1,
    identity,
    selection: { baselineId: "baseline", effectSetIds: [] },
    byteLength: 697,
    sha256: "a".repeat(64),
  };
  const shared = {
    version: 1,
    identity,
    selection: { baselineId: "baseline", effectSets: [] },
    byteLength: 800,
    sha256: "b".repeat(64),
  };
  await rememberLocalRecoveryCheckpoint(db, local);
  const other = await openDb(`file:${path}`);
  await other.db.values(sql`PRAGMA busy_timeout=1`);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const registering = withTx(db, async (tx) => {
    await rememberSharedRecoveryCheckpointInTx(tx, shared);
    entered.resolve();
    await proceed.promise;
  });
  void registering.catch(() => undefined);
  try {
    await entered.promise;
    expect(await inspectSharedRecoveryCheckpoint(other.db, key)).toBeNull();
    // libsql replaces its idle connection after each transaction, resetting connection-local pragmas.
    await other.db.values(sql`PRAGMA busy_timeout=1`);
    await expect(
      rememberSharedRecoveryCheckpoint(other.db, { ...shared, sha256: "c".repeat(64) }),
    ).rejects.toThrow();
    await other.db.values(sql`PRAGMA busy_timeout=1`);
    await expect(
      withTx(other.db, (tx) => tx.run(sql`DELETE FROM local_recovery_checkpoint`)),
    ).rejects.toThrow();
  } finally {
    proceed.resolve();
    await registering;
    other.close();
  }
  const reopened = await openDb(`file:${path}`);
  try {
    expect(await inspectSharedRecoveryCheckpoint(reopened.db, key)).toEqual({
      checkpoint: shared,
      localCheckpoint: local,
    });
    expect((await rememberSharedRecoveryCheckpoint(reopened.db, shared)).changed).toBe(false);
    await expect(
      rememberSharedRecoveryCheckpoint(reopened.db, { ...shared, sha256: "c".repeat(64) }),
    ).rejects.toThrow("different contents");
  } finally {
    reopened.close();
  }
});
