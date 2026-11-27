import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { withTx, type ReadTx } from "@kozane/core/database";
import {
  captureRecoveryCheckpoint,
  parseSharedRecoveryProjection,
  type SharedRecoveryEffect,
} from "@kozane/core/recovery";
import { migrations } from "@kozane/core/migrations";
import { openDb } from "../../db/client.js";
import { migrateNodeDatabase } from "../../db/tx.js";
import { capturedTables } from "../../test-utils/action-tables.js";

let root: string | undefined;
const handles: Awaited<ReturnType<typeof openDb>>[] = [];
async function open(path: string) {
  const handle = await openDb(path);
  handles.push(handle);
  return handle;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const handle of handles.splice(0)) handle.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});
async function fixture() {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-consistent-recovery-"));
  const path = `file:${join(root, "db.sqlite")}`,
    source = await open(path);
  await migrateNodeDatabase(source.db, { migrationsFolder: resolve("drizzle") });
  const writer = await open(path);
  const identity = {
    workspaceId: "workspace",
    deviceId: "device",
    epochId: "epoch",
    checkpointId: "checkpoint",
    schemaId: migrations.at(-1)!.id,
  };
  const row = (name: string) => ({ id: ["text", "s"] as const, name: ["text", name] as const });
  const effect = (before: string, after: string): SharedRecoveryEffect => ({
    ord: 0,
    table: "scope",
    key: { id: ["text", "s"] },
    op: "U",
    before: row(before),
    after: row(after),
  });
  const projection = parseSharedRecoveryProjection({
    version: 1,
    rowEncodingVersion: 1,
    schemaId: identity.schemaId,
    tables: capturedTables.map((table) => ({
      name: table.name,
      rows: table.name === "scope" ? [row("baseline")] : [],
    })),
  });
  const history = {
    baseline: { id: "baseline", projection },
    effectSets: [{ id: "first", effects: [effect("baseline", "snapshot")] }],
  };
  const selection = { baselineId: "baseline", effectSets: [{ id: "first", effectCount: 1 }] };
  await source.db.run(sql`INSERT INTO scope(id,name) VALUES('s','snapshot')`);
  await source.db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/snapshot','workspace_relative',9007199254740993)`,
  );
  await source.db.run(
    sql`CREATE TABLE checkpoint_history(history TEXT NOT NULL,selection TEXT NOT NULL)`,
  );
  await source.db.run(
    sql`INSERT INTO checkpoint_history VALUES(${JSON.stringify(history)},${JSON.stringify(selection)})`,
  );
  const read = async (tx: ReadTx) => {
    const [value] = await tx.values(sql`SELECT history,selection FROM checkpoint_history`);
    return { history: JSON.parse(String(value[0])), selection: JSON.parse(String(value[1])) };
  };
  async function advance() {
    await withTx(writer.db, async (tx) => {
      const changed = {
        ...history,
        effectSets: [
          ...history.effectSets,
          { id: "second", effects: [effect("snapshot", "after")] },
        ],
      };
      const selected = {
        ...selection,
        effectSets: [...selection.effectSets, { id: "second", effectCount: 1 }],
      };
      await tx.run(
        sql`UPDATE checkpoint_history SET history=${JSON.stringify(changed)},selection=${JSON.stringify(selected)}`,
      );
      await tx.run(sql`UPDATE scope SET name='after' WHERE id='s'`);
      await tx.run(
        sql`UPDATE taskspace_local SET path='local/after',last_seen_at=9007199254740995`,
      );
    });
  }
  return { source, writer, identity, read, advance };
}
it("keeps local rows, full shared history and its current projection together while another connection commits", async () => {
  const f = await fixture();
  let reads = 0;
  const captured = await captureRecoveryCheckpoint(f.source.db, f.identity, async (tx) => {
    const selected = await f.read(tx);
    reads++;
    await f.advance();
    return selected;
  });
  expect(reads).toBe(1);
  expect(captured.local.snapshot.selection.effectSetIds).toEqual(["first"]);
  expect(captured.shared.payload.selection.effectSets).toEqual([{ id: "first", effectCount: 1 }]);
  expect(
    captured.shared.projection.tables.find((table) => table.name === "scope")!.rows[0].name,
  ).toEqual(["text", "snapshot"]);
  expect(
    captured.local.snapshot.tables.find((table) => table.name === "taskspace_local")!.rows[0],
  ).toMatchObject({
    path: ["text", "local/snapshot"],
    last_seen_at: ["integer", "9007199254740993"],
  });
  const later = await captureRecoveryCheckpoint(
    f.source.db,
    { ...f.identity, checkpointId: "later" },
    f.read,
  );
  expect(later.local.snapshot.selection.effectSetIds).toEqual(["first", "second"]);
  expect(
    later.shared.projection.tables.find((table) => table.name === "scope")!.rows[0].name,
  ).toEqual(["text", "after"]);
  expect(
    later.local.snapshot.tables.find((table) => table.name === "taskspace_local")!.rows[0],
  ).toMatchObject({ path: ["text", "local/after"], last_seen_at: ["integer", "9007199254740995"] });
});
it("hashes the owned snapshot after read completion while later writes commit independently", async () => {
  const f = await fixture(),
    digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let advanced = false;
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    if (!advanced) {
      advanced = true;
      await f.advance();
    }
    return digest(algorithm, data);
  });
  const captured = await captureRecoveryCheckpoint(f.source.db, f.identity, f.read);
  expect(advanced).toBe(true);
  expect(captured.local.snapshot.selection.effectSetIds).toEqual(["first"]);
  expect(captured.shared.payload.selection.effectSets).toEqual([{ id: "first", effectCount: 1 }]);
  expect((await f.source.db.values(sql`SELECT path FROM taskspace_local`))[0][0]).toBe(
    "local/after",
  );
  expect((await f.source.db.values(sql`SELECT name FROM scope`))[0][0]).toBe("after");
});
