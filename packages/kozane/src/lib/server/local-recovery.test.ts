import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { withTx } from "../../db/database.js";
import type { DB } from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { captureLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("keeps local rows and shared-history selection at one checkpoint while another connection commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "kozane-local-recovery-checkpoint-"));
  roots.push(root);
  const path = join(root, "db.sqlite");
  const db = await createTestDB(path);
  const writer = await openDb(`file:${path}`);
  try {
    await db.run(
      sql`CREATE TABLE recovery_checkpoint(singleton INTEGER PRIMARY KEY,baseline TEXT,effects TEXT)`,
    );
    await db.run(
      sql`INSERT INTO recovery_checkpoint VALUES(1,'baseline-before','["origin-before"]')`,
    );
    await db.run(
      sql`INSERT INTO taskspace_local VALUES('absent','local/before','workspace_relative',9007199254740993)`,
    );
    const keys = {
      workspaceId: "workspace",
      deviceId: "device",
      epochId: "epoch",
      checkpointId: "checkpoint",
      schemaId: migrations.at(-1)!.id,
    };
    let reads = 0;
    const snapshot = await captureLocalRecoverySnapshot(db as unknown as DB, keys, async (tx) => {
      const [selection] = await tx.values(sql`SELECT baseline,effects FROM recovery_checkpoint`);
      // WAL permits this independent transaction to commit while the read snapshot stays open.
      await withTx(writer.db, async (write) => {
        await write.run(
          sql`UPDATE recovery_checkpoint SET baseline='baseline-after',effects='["origin-after"]'`,
        );
        await write.run(
          sql`UPDATE taskspace_local SET path='local/after',last_seen_at=9007199254740995`,
        );
      });
      reads++;
      return { baselineId: String(selection[0]), effectSetIds: JSON.parse(String(selection[1])) };
    });
    expect(reads).toBe(1);
    expect(snapshot.selection).toEqual({
      baselineId: "baseline-before",
      effectSetIds: ["origin-before"],
    });
    expect(
      snapshot.tables.find((table) => table.name === "taskspace_local")!.rows[0],
    ).toMatchObject({
      path: ["text", "local/before"],
      last_seen_at: ["integer", "9007199254740993"],
    });
    const later = await captureLocalRecoverySnapshot(
      db as unknown as DB,
      { ...keys, checkpointId: "later" },
      async (tx) => {
        const [selection] = await tx.values(sql`SELECT baseline,effects FROM recovery_checkpoint`);
        return { baselineId: String(selection[0]), effectSetIds: JSON.parse(String(selection[1])) };
      },
    );
    expect(later.selection).toEqual({
      baselineId: "baseline-after",
      effectSetIds: ["origin-after"],
    });
    expect(later.tables.find((table) => table.name === "taskspace_local")!.rows[0]).toMatchObject({
      path: ["text", "local/after"],
      last_seen_at: ["integer", "9007199254740995"],
    });
    expect(snapshot.identity.checkpointId).toBe("checkpoint");
  } finally {
    writer.close();
  }
});
