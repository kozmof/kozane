import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDatabaseAdapter,
  withReadTx,
  withTx,
  type DatabaseHandle,
} from "@kozane/core/database";
import * as recovery from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { identity } from "../../test-utils/retained-recovery-assets.js";
import { runArchiveAssetFixture } from "../../test-utils/run-archive-assets.js";
beforeEach(async () => {
  if (!crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const receiving = { ...identity, deviceId: "receiving-device" };
async function fixture(mode: recovery.RecoveryStagingDestination["mode"] = "complete") {
  const source = await runArchiveAssetFixture(),
    assets = await recovery.describeRunArchiveAssets(source),
    bundle = await recovery.describeRecoveryBundleIndex(assets.checkpoint, {
      localSnapshot: source.localSnapshot,
      sharedHistory: source.sharedHistory,
      executions: source.executions,
      originalActions: source.originalActions,
      actionArchive: source.actionArchive,
      runArchive: source.runArchive,
      currentAssets: source.currentAssets,
      runAssets: assets.payload,
    }),
    destination = await createTestDB();
  const destinationExpected = mode === "complete" ? identity : receiving;
  if (mode === "complete") {
    await recovery.installLocalRecoverySnapshot(
      destination,
      createTestDB,
      source.localSnapshot,
      bundle.checkpoint,
      identity,
    );
    await recovery.installSharedRecoverySnapshot(
      destination,
      createTestDB,
      source.sharedHistory,
      bundle.checkpoint,
      identity,
    );
  } else
    await recovery.installSharedOnlyRecoverySnapshot(
      destination,
      createTestDB,
      source.sharedHistory,
      bundle.checkpoint,
      identity,
      receiving,
    );
  const inspect = (
    db = destination,
    checkpoint: unknown = bundle.checkpoint,
    expected = identity,
    target = destinationExpected,
    requestedMode = mode,
  ) => recovery.inspectRecoveryStagingDestination(db, checkpoint, expected, target, requestedMode);
  return { source, destination, checkpoint: bundle.checkpoint, destinationExpected, inspect };
}
it.each(["complete", "shared-only"] as const)(
  "authenticates %s staging metadata in read and write transactions",
  async (mode) => {
    const f = await fixture(mode),
      expected = { checkpoint: f.checkpoint, destinationIdentity: f.destinationExpected, mode };
    expect(await f.inspect()).toEqual(expected);
    expect(
      await withReadTx(f.destination, (tx) =>
        recovery.readRecoveryStagingDestination(
          tx,
          f.checkpoint,
          identity,
          f.destinationExpected,
          mode,
        ),
      ),
    ).toEqual(expected);
    expect(
      await withTx(f.destination, (tx) =>
        recovery.readRecoveryStagingDestination(
          tx,
          f.checkpoint,
          identity,
          f.destinationExpected,
          mode,
        ),
      ),
    ).toEqual(expected);
  },
);
it("does not claim current rows or activation and preserves later edits", async () => {
  const f = await fixture("shared-only");
  await f.destination.run(sql`INSERT INTO namespace VALUES('later','Keep',0)`);
  await f.destination.run(
    sql`INSERT INTO taskspace_local VALUES('own','receiving/path','workspace_relative',9223372036854775807)`,
  );
  expect((await f.inspect()).mode).toBe("shared-only");
  expect(await f.destination.get(sql`SELECT name FROM namespace`)).toBeDefined();
});
it("requires both completed local and shared staging in complete mode", async () => {
  const f = await fixture(),
    db = await createTestDB();
  await expect(f.inspect(db)).rejects.toThrow("matching local and shared installations");
  await recovery.installLocalRecoverySnapshot(
    db,
    createTestDB,
    f.source.localSnapshot,
    f.checkpoint,
    identity,
  );
  await expect(f.inspect(db)).rejects.toThrow("matching local and shared installations");
});
it.each(["complete", "shared-only"] as const)(
  "refuses mismatched %s recovery mode",
  async (mode) => {
    const f = await fixture(mode);
    await expect(
      f.inspect(
        f.destination,
        f.checkpoint,
        identity,
        identity,
        mode === "complete" ? "shared-only" : "complete",
      ),
    ).rejects.toThrow("mode conflicts");
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "checks the independently trusted source %s",
  async (field) => {
    const f = await fixture();
    await expect(
      f.inspect(f.destination, f.checkpoint, { ...identity, [field]: "other" }),
    ).rejects.toThrow();
  },
);
it.each(["workspaceId", "epochId", "checkpointId", "schemaId"] as const)(
  "checks the independently trusted receiving %s",
  async (field) => {
    const f = await fixture("shared-only");
    await expect(
      f.inspect(f.destination, f.checkpoint, identity, { ...receiving, [field]: "other" }),
    ).rejects.toThrow();
  },
);
it("refuses another receiving device even when the source bundle matches", async () => {
  const f = await fixture("shared-only");
  await expect(
    f.inspect(f.destination, f.checkpoint, identity, { ...receiving, deviceId: "other" }),
  ).rejects.toThrow("matching shared-only installation");
});
it("requires the originating device for complete recovery", async () => {
  const f = await fixture();
  await expect(f.inspect(f.destination, f.checkpoint, identity, receiving)).rejects.toThrow(
    "originating device",
  );
});
it("refuses another bundle descriptor", async () => {
  const f = await fixture();
  await expect(
    f.inspect(f.destination, { ...f.checkpoint, sha256: "b".repeat(64) }),
  ).rejects.toThrow("matching local and shared installations");
});
it.each(["table", "guard", "history"])("refuses unsupported destination %s", async (kind) => {
  const f = await fixture();
  if (kind === "table") await f.destination.run(sql`CREATE TABLE unsupported(id TEXT)`);
  if (kind === "guard")
    await f.destination.run(sql`DROP TRIGGER shared_recovery_installation_no_delete`);
  if (kind === "history")
    await f.destination.run(
      sql`DELETE FROM __drizzle_migrations WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)`,
    );
  await expect(f.inspect()).rejects.toThrow();
});
it("refuses a second mode's authority instead of choosing an automatic fallback", async () => {
  const f = await fixture();
  await f.destination.run(
    sql`INSERT INTO shared_only_recovery_installation VALUES(1,${JSON.stringify(f.checkpoint)},${JSON.stringify(identity)},1)`,
  );
  await expect(f.inspect()).rejects.toThrow("mode conflicts");
});
it("owns both identities, mode and descriptor before the read hook yields", async () => {
  const f = await fixture("shared-only"),
    expected = { ...identity },
    target = { ...receiving },
    checkpoint = structuredClone(f.checkpoint) as any;
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
    read: (work) => {
      expected.deviceId = "Changed";
      target.deviceId = "Changed";
      checkpoint.sha256 = "b".repeat(64);
      return withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle));
    },
    write: () => {
      throw Error("Unexpected write");
    },
  });
  expect(await f.inspect(wrapped, checkpoint, expected, target)).toEqual({
    checkpoint: f.checkpoint,
    destinationIdentity: receiving,
    mode: "shared-only",
  });
});
it("rejects success when read completion fails", async () => {
  const f = await fixture(),
    wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
      read: async (work) => {
        await withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle));
        throw Error("Read completion failed");
      },
      write: () => {
        throw Error("Unexpected write");
      },
    });
  await expect(f.inspect(wrapped)).rejects.toThrow("Read completion failed");
  expect((await f.inspect()).mode).toBe("complete");
});
