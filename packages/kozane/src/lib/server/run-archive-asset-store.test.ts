import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { withTx } from "@kozane/core/database";
import { migrations } from "@kozane/core/migrations";
import {
  rememberLocalRecoveryCheckpoint,
  rememberSharedRecoveryCheckpoint,
  rememberSharedRecoveryExecutionCheckpoint,
  rememberSharedRecoveryActionCheckpoint,
  rememberSharedRecoveryActionArchiveCheckpoint,
  rememberSharedRecoveryRunArchiveCheckpoint,
  rememberRecoveryAssetCheckpoint,
  rememberRunArchiveAssetCheckpoint,
  rememberRunArchiveAssetCheckpointInTx,
  inspectRunArchiveAssetCheckpoint,
} from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it.each(["same", "different", "rollback"])(
  "serializes %s runs-manifest registration across connections",
  async (scenario) => {
    root = await mkdtemp(join(tmpdir(), "kozane-runs-assets-catalog-"));
    const path = join(root, "db.sqlite");
    const db = await createTestDB(path);
    const other = await openDb(`file:${path}`);
    const identity = {
      workspaceId: "workspace",
      deviceId: "device",
      epochId: "epoch",
      checkpointId: "checkpoint",
      schemaId: migrations.at(-1)!.id,
    };
    const key = {
      workspaceId: identity.workspaceId,
      deviceId: identity.deviceId,
      epochId: identity.epochId,
      checkpointId: identity.checkpointId,
    };
    const local = {
      version: 1,
      identity,
      selection: { baselineId: "baseline", effectSetIds: [] },
      byteLength: 1,
      sha256: "a".repeat(64),
    };
    const shared = {
      version: 1,
      identity,
      selection: { baselineId: "baseline", effectSets: [] },
      byteLength: 2,
      sha256: "b".repeat(64),
    };
    await rememberLocalRecoveryCheckpoint(db, local);
    const { binding } = await rememberSharedRecoveryCheckpoint(db, shared);
    const execution = {
      version: 1,
      checkpoint: binding.checkpoint,
      selection: { baselineId: "baseline", effectSets: [] },
      byteLength: 3,
      sha256: "c".repeat(64),
    };
    await rememberSharedRecoveryExecutionCheckpoint(db, execution);
    const original = {
      version: 1,
      checkpoint: execution,
      selection: { actionIds: [] },
      byteLength: 4,
      sha256: "d".repeat(64),
    };
    await rememberSharedRecoveryActionCheckpoint(db, original);
    const actionArchive = {
      version: 1,
      checkpoint: original,
      selection: { rootIds: ["unselected"], actionIds: ["unselected"] },
      byteLength: 5,
      sha256: "e".repeat(64),
    };
    await rememberSharedRecoveryActionArchiveCheckpoint(db, actionArchive);
    const runs = {
      version: 1,
      checkpoint: actionArchive,
      selection: { effectSets: [] },
      byteLength: 5,
      sha256: "e".repeat(64),
    };
    await rememberSharedRecoveryRunArchiveCheckpoint(db, runs);
    const current = {
      version: 1,
      binding: { checkpoint: shared, localCheckpoint: local },
      byteLength: 6,
      sha256: "f".repeat(64),
    };
    await rememberRecoveryAssetCheckpoint(db, current);
    const checkpoint = {
      version: 1,
      binding: { checkpoint: runs, localCheckpoint: local },
      assetCheckpoint: current,
      byteLength: 7,
      sha256: "a".repeat(64),
    };
    const competing = {
      ...checkpoint,
      sha256: scenario === "same" ? checkpoint.sha256 : "f".repeat(64),
    };
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const writing = withTx(db, async (tx) => {
      await rememberRunArchiveAssetCheckpointInTx(tx, checkpoint);
      entered.resolve();
      await proceed.promise;
      if (scenario === "rollback") throw new Error("Rollback requested");
    });
    const finished = writing.then(
      () => null,
      (error) => error,
    );
    try {
      await entered.promise;
      expect(await inspectRunArchiveAssetCheckpoint(other.db, key)).toBeNull();
      await other.db.values(sql`PRAGMA busy_timeout=1`);
      await expect(rememberRunArchiveAssetCheckpoint(other.db, competing)).rejects.toThrow();
      proceed.resolve();
      const failure = await finished;
      if (scenario === "rollback") expect(failure).toBeInstanceOf(Error);
      else expect(failure).toBeNull();
      if (scenario === "different") {
        await expect(rememberRunArchiveAssetCheckpoint(other.db, competing)).rejects.toThrow(
          "different contents or bindings",
        );
        expect(await inspectRunArchiveAssetCheckpoint(other.db, key)).toEqual(checkpoint);
      } else {
        expect((await rememberRunArchiveAssetCheckpoint(other.db, competing)).changed).toBe(
          scenario === "rollback",
        );
        expect(await inspectRunArchiveAssetCheckpoint(other.db, key)).toEqual(competing);
      }
    } finally {
      proceed.resolve();
      await finished;
      other.close();
    }
  },
);
