import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import {
  withTx,
  withReadTx,
  createDatabaseAdapter,
  type DatabaseHandle,
} from "@kozane/core/database";
import * as recovery from "@kozane/core/recovery";
import { openDb } from "../../db/client.js";
import { migrateNodeDatabase } from "../../db/tx.js";
import { runArchiveAssetFixture } from "../../test-utils/run-archive-assets.js";
import { identity } from "../../test-utils/retained-recovery-assets.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["same", "different", "rollback"] as const)(
  "serializes competing shared destination installations (%s)",
  async (mode) => {
    if (!crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
    const root = await fs.mkdtemp(join(tmpdir(), "kozane-shared-installation-race-")),
      opened: Awaited<ReturnType<typeof openDb>>[] = [];
    try {
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
        });
      const first = await openDb(`file:${join(root, "db.sqlite")}`);
      opened.push(first);
      await migrateNodeDatabase(first.db, { migrationsFolder: resolve("drizzle") });
      const second = await openDb(`file:${join(root, "db.sqlite")}`);
      opened.push(second);
      const factory = async () => {
        const value = await openDb(":memory:");
        opened.push(value);
        return value.db;
      };
      await recovery.installLocalRecoverySnapshot(
        first.db,
        factory,
        source.localSnapshot,
        bundle.checkpoint,
        identity,
      );
      const entered = Promise.withResolvers<void>(),
        proceed = Promise.withResolvers<void>();
      const wrapped = createDatabaseAdapter(new Proxy(first.db, {}), {
        read: (work) => withReadTx(first.db, (tx) => work(tx as unknown as DatabaseHandle)),
        write: (work) =>
          withTx(first.db, async (tx) => {
            const result = await work(tx);
            entered.resolve();
            await proceed.promise;
            if (mode === "rollback") throw Error("Cancelled installation");
            return result;
          }),
      });
      const installing = recovery.installSharedRecoverySnapshot(
        wrapped,
        factory,
        source.sharedHistory,
        bundle.checkpoint,
        identity,
      );
      try {
        await entered.promise;
        expect(await recovery.inspectSharedRecoveryInstallation(second.db)).toBeNull();
        expect(await second.db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
        await second.db.values(sql`PRAGMA busy_timeout=1`);
        const competing =
          mode === "different"
            ? { ...bundle.checkpoint, sha256: "b".repeat(64) }
            : bundle.checkpoint;
        await expect(
          recovery.installSharedRecoverySnapshot(
            second.db,
            factory,
            source.sharedHistory,
            competing,
            identity,
          ),
        ).rejects.toThrow();
        proceed.resolve();
        if (mode === "rollback") await expect(installing).rejects.toThrow("Cancelled");
        else expect((await installing).changed).toBe(true);
        if (mode === "different")
          await expect(
            recovery.installSharedRecoverySnapshot(
              second.db,
              factory,
              source.sharedHistory,
              competing,
              identity,
            ),
          ).rejects.toThrow("matching local installation");
        else
          expect(
            (
              await recovery.installSharedRecoverySnapshot(
                second.db,
                factory,
                source.sharedHistory,
                bundle.checkpoint,
                identity,
              )
            ).changed,
          ).toBe(mode === "rollback");
        const reopened = await openDb(`file:${join(root, "db.sqlite")}`);
        opened.push(reopened);
        expect(await recovery.inspectSharedRecoveryInstallation(reopened.db)).toEqual(
          bundle.checkpoint,
        );
        await reopened.db.run(
          sql`INSERT INTO taskspace_local VALUES('later','Keep','workspace_relative',0)`,
        );
        expect(
          (
            await recovery.installSharedRecoverySnapshot(
              reopened.db,
              factory,
              source.sharedHistory,
              bundle.checkpoint,
              identity,
            )
          ).changed,
        ).toBe(false);
        expect(await reopened.db.get(sql`SELECT path FROM taskspace_local`)).toMatchObject({
          path: "Keep",
        });
      } finally {
        proceed.resolve();
        await installing.catch(() => undefined);
      }
    } finally {
      for (const db of opened) db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
