import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema";
import { runMigrations } from "./db";
import type { DbJsonDump } from "./db-json/format.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import {
  TABLES,
  dumpLimitWarnings,
  exportDbJson,
  hasDbJsonRows,
  importDbJson,
  stringifyDbJson,
} from "./db-json";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-db-json-test-"));
  tempRoots.push(root);
  return root;
}

function tempDbUrl(path: string): string {
  return `file:${path}`;
}

async function migratedDbUrl(name: string): Promise<string> {
  const dbUrl = tempDbUrl(join(tempRoot(), name));
  await runMigrations(dbUrl);
  return dbUrl;
}

async function seedDb(dbUrl: string): Promise<void> {
  const client = createClient({ url: dbUrl });
  try {
    await client.batch(
      [
        {
          sql: "INSERT INTO namespace (id, name) VALUES (?, ?)",
          args: ["namespace-1", "Portable Namespace"],
        },
        {
          sql: "INSERT INTO scope (id, name) VALUES (?, ?)",
          args: ["scope-1", "Planning"],
        },
        {
          sql: "INSERT INTO partition (id, namespace_id, name, is_default) VALUES (?, ?, ?, ?)",
          args: ["partition-1", "namespace-1", "General", 1],
        },
        {
          sql: "INSERT INTO layer (id, namespace_id, name, position, is_default) VALUES (?, ?, ?, ?, ?)",
          args: ["layer-1", "namespace-1", "Base", 0, 1],
        },
        {
          sql: "INSERT INTO warp (id, namespace_id, pos_x, pos_y) VALUES (?, ?, ?, ?)",
          args: ["warp-1", "namespace-1", 240, 480],
        },
        {
          sql: "INSERT INTO inventory (id, namespace_id, name, pos_x, pos_y) VALUES (?, ?, ?, ?, ?)",
          args: ["inventory-1", "namespace-1", "Kept", 600, 720],
        },
        {
          sql: "INSERT INTO taskspace (id, namespace_id, scope_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          args: [
            "taskspace-1",
            "namespace-1",
            "scope-1",
            "Main",
            1_700_000_000_000,
            1_700_000_000_001,
          ],
        },
        {
          sql: "INSERT INTO taskspace_local(taskspace_id,path,path_kind,last_seen_at) VALUES(?,?,?,?)",
          args: ["taskspace-1", ".kozane/taskspaces/main", "workspace_relative", 1_800_000_000_000],
        },
        // Set timestamps explicitly to avoid the epoch default.
        {
          sql: "INSERT INTO card (id, partition_id, layer_id, taskspace_id, content, pos_x, pos_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())",
          args: ["card-1", "partition-1", "layer-1", "taskspace-1", "First", 10, 20],
        },
        {
          // Stored, so the dump carries both inventory columns filled in. The board would have
          // taken it out of its glue group on the way in. A dump moves rows as they are.
          sql: "INSERT INTO card (id, partition_id, layer_id, taskspace_id, content, pos_x, pos_y, inventory_id, inventory_slot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())",
          args: ["card-2", "partition-1", "layer-1", null, "Second", 30, 40, "inventory-1", 4],
        },
        {
          sql: "INSERT INTO glue (id) VALUES (?)",
          args: ["glue-1"],
        },
        {
          sql: "INSERT INTO glue_rel (glue_id, card_id) VALUES (?, ?)",
          args: ["glue-1", "card-1"],
        },
        {
          sql: "INSERT INTO glue_rel (glue_id, card_id) VALUES (?, ?)",
          args: ["glue-1", "card-2"],
        },
        {
          sql: "INSERT INTO scope_rel (scope_id, card_id) VALUES (?, ?)",
          args: ["scope-1", "card-1"],
        },
        {
          sql: "INSERT INTO scope_area (id, scope_id, namespace_id, pos_x, pos_y, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: ["scope-area-1", "scope-1", "namespace-1", 100, 200, 640, 480],
        },
      ],
      "write",
    );
  } finally {
    client.close();
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }
});

describe("db JSON export/import", () => {
  it("round-trips database rows through JSON", async () => {
    const sourceUrl = await migratedDbUrl("source.db");
    const targetUrl = await migratedDbUrl("target.db");
    await seedDb(sourceUrl);

    const sourceDump = await exportDbJson(sourceUrl);
    const counts = await importDbJson(targetUrl, sourceDump);
    const targetDump = await exportDbJson(targetUrl);

    expect(counts).toEqual({
      namespace: 1,
      scope: 1,
      scope_area: 1,
      partition: 1,
      layer: 1,
      warp: 1,
      inventory: 1,
      taskspace: 1,
      taskspace_local: 1,
      local_file_operation: 0,
      local_image_upload: 0,
      local_asset_manifest: 0,
      local_recovery_checkpoint: 0,
      local_recovery_shared_history: 0,
      local_recovery_assets: 0,
      local_recovery_executions: 0,
      local_recovery_actions: 0,
      local_recovery_retained_history: 0,
      local_recovery_retained_assets: 0,
      local_recovery_action_archives: 0,
      card: 2,
      glue: 1,
      glue_rel: 2,
      scope_rel: 1,
    });
    expect({ ...targetDump, exportedAt: sourceDump.exportedAt }).toEqual(sourceDump);
  });

  it("reports whether any exported table has rows", async () => {
    const dbUrl = await migratedDbUrl("rows.db");

    await expect(hasDbJsonRows(dbUrl)).resolves.toBe(false);
    await seedDb(dbUrl);
    await expect(hasDbJsonRows(dbUrl)).resolves.toBe(true);
  });

  it("preserves the default namespace flag", async () => {
    const sourceUrl = await migratedDbUrl("default-source.db");
    const targetUrl = await migratedDbUrl("default-target.db");
    await seedDb(sourceUrl);
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute("UPDATE namespace SET is_default = 1 WHERE id = 'namespace-1'");
    } finally {
      client.close();
    }

    await importDbJson(targetUrl, await exportDbJson(sourceUrl));

    const dump = await exportDbJson(targetUrl);
    expect(dump.tables.namespace[0].is_default).toBe(1);
  });

  // Verify that unsupported dump versions are rejected with an explanation suitable for a
  // user restoring a backup.
  it.each([2, 3, 4, 5, 6])(
    "refuses a version %i export, taken before the rename",
    async (version) => {
      const dbUrl = await migratedDbUrl(`v${version}-refused.db`);
      const legacy = { ...(await exportDbJson(dbUrl)), version };

      await expect(importDbJson(dbUrl, legacy)).rejects.toThrow(
        /predates the rename of "project" to "namespace"/,
      );
    },
  );

  it("tells the holder of an old dump what to do with it", async () => {
    const dbUrl = await migratedDbUrl("old-dump-advice.db");
    const legacy = { ...(await exportDbJson(dbUrl)), version: 6 };

    await expect(importDbJson(dbUrl, legacy)).rejects.toThrow(/kozane db migrate/);
  });

  function legacyTables(tables: DbJsonDump["tables"]) {
    const { taskspace_local, ...shared } = structuredClone(tables);
    return {
      ...shared,
      taskspace: shared.taskspace.map((row) => {
        const local = taskspace_local.find((local) => local.taskspace_id === row.id);
        return {
          ...row,
          path: local?.path ?? null,
          path_kind: local?.path_kind ?? "workspace_relative",
          last_seen_at: local?.last_seen_at ?? null,
        };
      }),
    };
  }

  it("imports version 9 inline taskspace attachments without mutating the original dump", async () => {
    const sourceUrl = await migratedDbUrl("v9-source.db");
    const targetUrl = await migratedDbUrl("v9-target.db");
    await seedDb(sourceUrl);
    const source = await exportDbJson(sourceUrl);
    const legacy = { ...source, version: 9, tables: legacyTables(source.tables) };
    const original = JSON.stringify(legacy);
    await importDbJson(targetUrl, legacy);
    expect(JSON.stringify(legacy)).toBe(original);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
  });

  it("round-trips retained local metadata for absent taskspaces", async () => {
    const sourceUrl = await migratedDbUrl("local-source.db");
    const targetUrl = await migratedDbUrl("local-target.db");
    await seedDb(sourceUrl);
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute(
        "INSERT INTO taskspace_local(taskspace_id,path,path_kind,last_seen_at) VALUES('absent','local/retained','workspace_relative',0)",
      );
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.tables.taskspace.some((row) => "path" in row || "last_seen_at" in row)).toBe(
      false,
    );
    expect((await importDbJson(targetUrl, source)).taskspace_local).toBe(2);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
  });

  it("round-trips retained manifest owners, refuses unsafe or conflicting identity and imports earlier dumps without pins", async () => {
    const sourceUrl = await migratedDbUrl("manifest-source.db");
    const targetUrl = await migratedDbUrl("manifest-target.db");
    const entry = {
      name: ".kozane/assets/images/00000000-0000-4000-8000-000000000001.svg",
      byteLength: 3,
      sha256: "a".repeat(64),
    };
    const manifest = JSON.stringify({ version: 1, entries: [entry] });
    const client = createClient({ url: sourceUrl });
    try {
      for (const state of ["pending", "retained", "released"])
        await client.execute({
          sql: "INSERT INTO local_asset_manifest(owner_kind,owner_id,manifest,state,created_at,verified_at,released_at,release_reason) VALUES('baseline',?,?,?,?,?,?,?)",
          args: [
            state,
            manifest,
            state,
            1,
            state === "retained" ? 2 : null,
            state === "released" ? 3 : null,
            state === "released" ? "History expired" : null,
          ],
        });
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_asset_manifest).toBe(3);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    const unsafe = structuredClone(source);
    unsafe.tables.local_asset_manifest[0].manifest = JSON.stringify({
      version: 1,
      entries: [{ ...entry, name: "../outside.svg" }],
    });
    await expect(importDbJson(targetUrl, unsafe)).rejects.toThrow("Invalid asset manifest entry");
    const conflict = structuredClone(source);
    conflict.tables.local_asset_manifest[0].manifest = JSON.stringify({
      version: 1,
      entries: [{ ...entry, sha256: "b".repeat(64) }],
    });
    await expect(importDbJson(targetUrl, conflict)).rejects.toThrow("Conflicting asset bytes");
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    const { local_asset_manifest: _manifests, ...tables } = source.tables;
    expect(
      (await importDbJson(targetUrl, { ...source, version: 15, tables })).local_asset_manifest,
    ).toBe(0);
  });

  it("round-trips checkpoint descriptors, preserves historical metadata and rejects invalid catalog identities", async () => {
    const sourceUrl = await migratedDbUrl("checkpoint-source.db");
    const targetUrl = await migratedDbUrl("checkpoint-target.db");
    const client = createClient({ url: sourceUrl });
    try {
      for (const [index, schemaId] of [
        "0026_local_asset_manifest",
        migrations.at(-1)!.id,
      ].entries()) {
        const descriptor = {
          version: 1,
          identity: {
            workspaceId: "workspace",
            deviceId: "device",
            epochId: "epoch",
            checkpointId: `checkpoint-${index}`,
            schemaId,
          },
          selection: { baselineId: "baseline", effectSetIds: [] },
          byteLength: 642,
          sha256: "a".repeat(64),
        };
        await client.execute({
          sql: "INSERT INTO local_recovery_checkpoint VALUES(?,?,?,?,?,?)",
          args: [
            "workspace",
            "device",
            "epoch",
            `checkpoint-${index}`,
            JSON.stringify(descriptor),
            1,
          ],
        });
      }
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_recovery_checkpoint).toBe(2);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    const wrongIdentity = structuredClone(source);
    wrongIdentity.tables.local_recovery_checkpoint[0].checkpoint_id = "different";
    await expect(importDbJson(targetUrl, wrongIdentity)).rejects.toThrow("identity mismatch");
    const malformed = structuredClone(source);
    const descriptor = JSON.parse(String(malformed.tables.local_recovery_checkpoint[0].descriptor));
    descriptor.sha256 = "bad";
    malformed.tables.local_recovery_checkpoint[0].descriptor = JSON.stringify(descriptor);
    await expect(importDbJson(targetUrl, malformed)).rejects.toThrow();
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    const { local_recovery_checkpoint: _catalog, ...tables } = source.tables;
    expect(
      (await importDbJson(targetUrl, { ...source, version: 16, tables })).local_recovery_checkpoint,
    ).toBe(0);
  });

  it("round-trips shared descriptor pairs and preserves historical metadata without installing history", async () => {
    const sourceUrl = await migratedDbUrl("shared-checkpoint-source.db");
    const targetUrl = await migratedDbUrl("shared-checkpoint-target.db");
    const client = createClient({ url: sourceUrl });
    try {
      for (const [index, schemaId] of [
        "0027_local_recovery_checkpoint",
        migrations.at(-1)!.id,
      ].entries()) {
        const identity = {
          workspaceId: "workspace",
          deviceId: "device",
          epochId: "epoch",
          checkpointId: `shared-${index}`,
          schemaId,
        };
        const local = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSetIds: ["a"] },
          byteLength: 697,
          sha256: "a".repeat(64),
        };
        const shared = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSets: [{ id: "a", effectCount: 0 }] },
          byteLength: 800,
          sha256: "b".repeat(64),
        };
        const values = [
          identity.workspaceId,
          identity.deviceId,
          identity.epochId,
          identity.checkpointId,
        ];
        await client.execute({
          sql: "INSERT INTO local_recovery_checkpoint VALUES(?,?,?,?,?,?)",
          args: [...values, JSON.stringify(local), 1],
        });
        await client.execute({
          sql: "INSERT INTO local_recovery_shared_history VALUES(?,?,?,?,?,?,?)",
          args: [...values, JSON.stringify(shared), JSON.stringify(local), 1],
        });
      }
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_recovery_shared_history).toBe(2);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    for (const change of ["identity", "hash", "local-selection"] as const) {
      const invalid = structuredClone(source);
      const row = invalid.tables.local_recovery_shared_history[0];
      if (change === "identity") row.checkpoint_id = "other";
      if (change === "hash")
        row.descriptor = JSON.stringify({ ...JSON.parse(String(row.descriptor)), sha256: "bad" });
      if (change === "local-selection")
        row.local_descriptor = JSON.stringify({
          ...JSON.parse(String(row.local_descriptor)),
          selection: { baselineId: "other", effectSetIds: ["a"] },
        });
      await expect(importDbJson(targetUrl, invalid)).rejects.toThrow();
      expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    }
    const { local_recovery_shared_history: _shared, ...tables } = source.tables;
    expect(
      (await importDbJson(targetUrl, { ...source, version: 17, tables }))
        .local_recovery_shared_history,
    ).toBe(0);
  });

  it("round-trips trusted recovery asset expectations and rejects malformed bindings before replacing rows", async () => {
    const sourceUrl = await migratedDbUrl("recovery-assets-source.db");
    const targetUrl = await migratedDbUrl("recovery-assets-target.db");
    await seedDb(targetUrl);
    const client = createClient({ url: sourceUrl });
    try {
      for (const [index, schemaId] of [migrations.at(-2)!.id, migrations.at(-1)!.id].entries()) {
        const identity = {
          workspaceId: "workspace",
          deviceId: "device",
          epochId: "epoch",
          checkpointId: `checkpoint-${index}`,
          schemaId,
        };
        const localCheckpoint = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSetIds: ["empty"] },
          byteLength: 700,
          sha256: "a".repeat(64),
        };
        const checkpoint = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSets: [{ id: "empty", effectCount: 0 }] },
          byteLength: 800,
          sha256: "b".repeat(64),
        };
        const descriptor = {
          version: 1,
          binding: { checkpoint, localCheckpoint },
          byteLength: 900,
          sha256: "c".repeat(64),
        };
        // Orphaned metadata remains useful evidence and has no cross-catalog foreign key.
        await client.execute({
          sql: "INSERT INTO local_recovery_assets VALUES(?,?,?,?,?,?)",
          args: [
            identity.workspaceId,
            identity.deviceId,
            identity.epochId,
            identity.checkpointId,
            JSON.stringify(descriptor),
            1,
          ],
        });
      }
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_recovery_assets).toBe(2);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    for (const change of [
      "identity",
      "hash",
      "shared-binding",
      "local-selection",
      "nested-version",
    ]) {
      const invalid = structuredClone(source);
      const row = invalid.tables.local_recovery_assets[0];
      const descriptor = JSON.parse(String(row.descriptor));
      if (change === "identity") row.checkpoint_id = "other";
      if (change === "hash") descriptor.sha256 = "bad";
      if (change === "shared-binding") descriptor.binding.checkpoint.identity.deviceId = "other";
      if (change === "local-selection")
        descriptor.binding.localCheckpoint.selection.baselineId = "other";
      if (change === "nested-version") descriptor.binding.localCheckpoint.version = 2;
      row.descriptor = JSON.stringify(descriptor);
      await expect(importDbJson(targetUrl, invalid)).rejects.toThrow();
      expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    }
    const { local_recovery_assets: _assets, ...tables } = source.tables;
    await expect(importDbJson(targetUrl, { ...source, tables })).rejects.toThrow(
      "missing table local_recovery_assets",
    );
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(
      (await importDbJson(targetUrl, { ...source, version: 18, tables })).local_recovery_assets,
    ).toBe(0);
    expect(source.tables.local_recovery_assets).toHaveLength(2);
  });

  it("round-trips trusted execution expectations and refuses malformed source bindings before replacing rows", async () => {
    const sourceUrl = await migratedDbUrl("executions-source.db"),
      targetUrl = await migratedDbUrl("executions-target.db");
    await seedDb(targetUrl);
    const client = createClient({ url: sourceUrl });
    try {
      for (const [index, schemaId] of [migrations.at(-2)!.id, migrations.at(-1)!.id].entries()) {
        const identity = {
          workspaceId: "workspace",
          deviceId: "device",
          epochId: "epoch",
          checkpointId: `checkpoint-${index}`,
          schemaId,
        };
        const local = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSetIds: ["empty"] },
          byteLength: 700,
          sha256: "a".repeat(64),
        };
        const shared = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSets: [{ id: "empty", effectCount: 0 }] },
          byteLength: 800,
          sha256: "b".repeat(64),
        };
        const descriptor = {
          version: 1,
          checkpoint: shared,
          selection: {
            baselineId: "baseline",
            effectSets: [{ id: "empty", rootId: "root", executionCount: 2 }],
          },
          byteLength: 900,
          sha256: "c".repeat(64),
        };
        await client.execute({
          sql: "INSERT INTO local_recovery_executions VALUES(?,?,?,?,?,?,?)",
          args: [
            identity.workspaceId,
            identity.deviceId,
            identity.epochId,
            identity.checkpointId,
            JSON.stringify(descriptor),
            JSON.stringify(local),
            1,
          ],
        });
      }
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_recovery_executions).toBe(2);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    for (const change of [
      "identity",
      "hash",
      "selection",
      "count",
      "local-identity",
      "local-selection",
    ]) {
      const invalid = structuredClone(source),
        row = invalid.tables.local_recovery_executions[0];
      const descriptor = JSON.parse(String(row.descriptor)),
        local = JSON.parse(String(row.local_descriptor));
      if (change === "identity") row.checkpoint_id = "other";
      if (change === "hash") descriptor.sha256 = "bad";
      if (change === "selection") descriptor.selection.baselineId = "other";
      if (change === "count") descriptor.selection.effectSets[0].executionCount = 0;
      if (change === "local-identity") local.identity.deviceId = "other";
      if (change === "local-selection") local.selection.effectSetIds = [];
      row.descriptor = JSON.stringify(descriptor);
      row.local_descriptor = JSON.stringify(local);
      await expect(importDbJson(targetUrl, invalid)).rejects.toThrow();
      expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    }
    const { local_recovery_executions: _executions, ...tables } = source.tables;
    await expect(importDbJson(targetUrl, { ...source, tables })).rejects.toThrow(
      "missing table local_recovery_executions",
    );
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(
      (await importDbJson(targetUrl, { ...source, version: 19, tables })).local_recovery_executions,
    ).toBe(0);
    expect(source.tables.local_recovery_executions).toHaveLength(2);
  });

  it("round-trips trusted original-action expectations and refuses malformed source bindings before replacing rows", async () => {
    const sourceUrl = await migratedDbUrl("actions-source.db"),
      targetUrl = await migratedDbUrl("actions-target.db");
    await seedDb(targetUrl);
    const client = createClient({ url: sourceUrl });
    try {
      for (const [index, schemaId] of [migrations.at(-2)!.id, migrations.at(-1)!.id].entries()) {
        const identity = {
          workspaceId: "workspace",
          deviceId: "device",
          epochId: "epoch",
          checkpointId: `checkpoint-${index}`,
          schemaId,
        };
        const local = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSetIds: ["empty"] },
          byteLength: 700,
          sha256: "a".repeat(64),
        };
        const shared = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSets: [{ id: "empty", effectCount: 0 }] },
          byteLength: 800,
          sha256: "b".repeat(64),
        };
        const execution = {
          version: 1,
          checkpoint: shared,
          selection: {
            baselineId: "baseline",
            effectSets: [{ id: "empty", rootId: "root", executionCount: 2 }],
          },
          byteLength: 900,
          sha256: "c".repeat(64),
        };
        const descriptor = {
          version: 1,
          checkpoint: execution,
          selection: { actionIds: ["root", "child"] },
          byteLength: 1000,
          sha256: "d".repeat(64),
        };
        await client.execute({
          sql: "INSERT INTO local_recovery_actions VALUES(?,?,?,?,?,?,?)",
          args: [
            identity.workspaceId,
            identity.deviceId,
            identity.epochId,
            identity.checkpointId,
            JSON.stringify(descriptor),
            JSON.stringify(local),
            1,
          ],
        });
      }
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_recovery_actions).toBe(2);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    for (const change of [
      "identity",
      "hash",
      "selection",
      "count",
      "local-identity",
      "local-selection",
    ]) {
      const invalid = structuredClone(source),
        row = invalid.tables.local_recovery_actions[0];
      const descriptor = JSON.parse(String(row.descriptor)),
        local = JSON.parse(String(row.local_descriptor));
      if (change === "identity") row.checkpoint_id = "other";
      if (change === "hash") descriptor.sha256 = "bad";
      if (change === "selection") descriptor.selection.actionIds = ["child"];
      if (change === "count") descriptor.checkpoint.selection.effectSets[0].executionCount = 0;
      if (change === "local-identity") local.identity.deviceId = "other";
      if (change === "local-selection") local.selection.effectSetIds = [];
      row.descriptor = JSON.stringify(descriptor);
      row.local_descriptor = JSON.stringify(local);
      await expect(importDbJson(targetUrl, invalid)).rejects.toThrow();
      expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    }
    const { local_recovery_actions: _actions, ...tables } = source.tables;
    await expect(importDbJson(targetUrl, { ...source, tables })).rejects.toThrow(
      "missing table local_recovery_actions",
    );
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(
      (await importDbJson(targetUrl, { ...source, version: 20, tables })).local_recovery_actions,
    ).toBe(0);
    expect(source.tables.local_recovery_actions).toHaveLength(2);
  });

  it("round-trips trusted retained-history expectations and refuses malformed source bindings before replacing rows", async () => {
    const sourceUrl = await migratedDbUrl("retained-source.db"),
      targetUrl = await migratedDbUrl("retained-target.db");
    await seedDb(targetUrl);
    const client = createClient({ url: sourceUrl });
    try {
      for (const [index, schemaId] of [migrations.at(-2)!.id, migrations.at(-1)!.id].entries()) {
        const identity = {
          workspaceId: "workspace",
          deviceId: "device",
          epochId: "epoch",
          checkpointId: `checkpoint-${index}`,
          schemaId,
        };
        const local = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSetIds: ["empty"] },
          byteLength: 700,
          sha256: "a".repeat(64),
        };
        const shared = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSets: [{ id: "empty", effectCount: 0 }] },
          byteLength: 800,
          sha256: "b".repeat(64),
        };
        const execution = {
          version: 1,
          checkpoint: shared,
          selection: {
            baselineId: "baseline",
            effectSets: [{ id: "empty", rootId: "root", executionCount: 2 }],
          },
          byteLength: 900,
          sha256: "c".repeat(64),
        };
        const original = {
          version: 1,
          checkpoint: execution,
          selection: { actionIds: ["root", "child"] },
          byteLength: 1000,
          sha256: "d".repeat(64),
        };
        const descriptor = {
          version: 1,
          checkpoint: original,
          selection: {
            effectSets: [
              {
                id: "origin",
                rootId: "root",
                source: "origin",
                baselineId: "before-origin",
                effectCount: 3,
                executionCount: 2,
              },
              {
                id: "empty",
                rootId: "root",
                source: "authoritative",
                baselineId: "baseline",
                effectCount: 0,
                executionCount: 2,
              },
            ],
          },
          byteLength: 2000,
          sha256: "e".repeat(64),
        };
        await client.execute({
          sql: "INSERT INTO local_recovery_retained_history VALUES(?,?,?,?,?,?,?)",
          args: [
            identity.workspaceId,
            identity.deviceId,
            identity.epochId,
            identity.checkpointId,
            JSON.stringify(descriptor),
            JSON.stringify(local),
            1,
          ],
        });
      }
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_recovery_retained_history).toBe(2);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    for (const change of [
      "identity",
      "hash",
      "selection",
      "count",
      "local-identity",
      "local-selection",
    ]) {
      const invalid = structuredClone(source),
        row = invalid.tables.local_recovery_retained_history[0];
      const descriptor = JSON.parse(String(row.descriptor)),
        local = JSON.parse(String(row.local_descriptor));
      if (change === "identity") row.checkpoint_id = "other";
      if (change === "hash") descriptor.sha256 = "bad";
      if (change === "selection") descriptor.selection.effectSets.pop();
      if (change === "count") descriptor.selection.effectSets[1].effectCount = 1;
      if (change === "local-identity") local.identity.deviceId = "other";
      if (change === "local-selection") local.selection.effectSetIds = [];
      row.descriptor = JSON.stringify(descriptor);
      row.local_descriptor = JSON.stringify(local);
      await expect(importDbJson(targetUrl, invalid)).rejects.toThrow();
      expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    }
    const { local_recovery_retained_history: _actions, ...tables } = source.tables;
    await expect(importDbJson(targetUrl, { ...source, tables })).rejects.toThrow(
      "missing table local_recovery_retained_history",
    );
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(
      (await importDbJson(targetUrl, { ...source, version: 21, tables }))
        .local_recovery_retained_history,
    ).toBe(0);
    expect(source.tables.local_recovery_retained_history).toHaveLength(2);
  });

  it("round-trips trusted action-archive expectations and refuses malformed source bindings before replacing rows", async () => {
    const sourceUrl = await migratedDbUrl("archive-source.db"),
      targetUrl = await migratedDbUrl("archive-target.db");
    await seedDb(targetUrl);
    const client = createClient({ url: sourceUrl });
    try {
      for (const [index, schemaId] of [migrations.at(-2)!.id, migrations.at(-1)!.id].entries()) {
        const identity = {
          workspaceId: "workspace",
          deviceId: "device",
          epochId: "epoch",
          checkpointId: `checkpoint-${index}`,
          schemaId,
        };
        const local = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSetIds: ["empty"] },
          byteLength: 700,
          sha256: "a".repeat(64),
        };
        const shared = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSets: [{ id: "empty", effectCount: 0 }] },
          byteLength: 800,
          sha256: "b".repeat(64),
        };
        const execution = {
          version: 1,
          checkpoint: shared,
          selection: {
            baselineId: "baseline",
            effectSets: [{ id: "empty", rootId: "root", executionCount: 2 }],
          },
          byteLength: 900,
          sha256: "c".repeat(64),
        };
        const original = {
          version: 1,
          checkpoint: execution,
          selection: { actionIds: ["root", "child"] },
          byteLength: 1000,
          sha256: "d".repeat(64),
        };
        const descriptor = {
          version: 1,
          checkpoint: original,
          selection: {
            rootIds: ["root", "unselected"],
            actionIds: ["root", "child", "unselected", "skipped"],
          },
          byteLength: 2000,
          sha256: "e".repeat(64),
        };
        await client.execute({
          sql: "INSERT INTO local_recovery_action_archives VALUES(?,?,?,?,?,?,?)",
          args: [
            identity.workspaceId,
            identity.deviceId,
            identity.epochId,
            identity.checkpointId,
            JSON.stringify(descriptor),
            JSON.stringify(local),
            1,
          ],
        });
      }
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_recovery_action_archives).toBe(2);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    for (const change of [
      "identity",
      "hash",
      "selection",
      "count",
      "local-identity",
      "local-selection",
    ]) {
      const invalid = structuredClone(source),
        row = invalid.tables.local_recovery_action_archives[0];
      const descriptor = JSON.parse(String(row.descriptor)),
        local = JSON.parse(String(row.local_descriptor));
      if (change === "identity") row.checkpoint_id = "other";
      if (change === "hash") descriptor.sha256 = "bad";
      if (change === "selection") descriptor.selection.rootIds.shift();
      if (change === "count") descriptor.selection.actionIds = ["root", "unselected"];
      if (change === "local-identity") local.identity.deviceId = "other";
      if (change === "local-selection") local.selection.effectSetIds = [];
      row.descriptor = JSON.stringify(descriptor);
      row.local_descriptor = JSON.stringify(local);
      await expect(importDbJson(targetUrl, invalid)).rejects.toThrow();
      expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    }
    const { local_recovery_action_archives: _actions, ...tables } = source.tables;
    await expect(importDbJson(targetUrl, { ...source, tables })).rejects.toThrow(
      "missing table local_recovery_action_archives",
    );
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(
      (await importDbJson(targetUrl, { ...source, version: 23, tables }))
        .local_recovery_action_archives,
    ).toBe(0);
    expect(source.tables.local_recovery_action_archives).toHaveLength(2);
  });

  it("round-trips trusted retained-manifest expectations and refuses malformed source bindings before replacing rows", async () => {
    const sourceUrl = await migratedDbUrl("retained-assets-source.db"),
      targetUrl = await migratedDbUrl("retained-assets-target.db");
    await seedDb(targetUrl);
    const client = createClient({ url: sourceUrl });
    try {
      for (const [index, schemaId] of [migrations.at(-2)!.id, migrations.at(-1)!.id].entries()) {
        const identity = {
          workspaceId: "workspace",
          deviceId: "device",
          epochId: "epoch",
          checkpointId: `checkpoint-${index}`,
          schemaId,
        };
        const local = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSetIds: ["empty"] },
          byteLength: 700,
          sha256: "a".repeat(64),
        };
        const shared = {
          version: 1,
          identity,
          selection: { baselineId: "baseline", effectSets: [{ id: "empty", effectCount: 0 }] },
          byteLength: 800,
          sha256: "b".repeat(64),
        };
        const execution = {
          version: 1,
          checkpoint: shared,
          selection: {
            baselineId: "baseline",
            effectSets: [{ id: "empty", rootId: "root", executionCount: 2 }],
          },
          byteLength: 900,
          sha256: "c".repeat(64),
        };
        const original = {
          version: 1,
          checkpoint: execution,
          selection: { actionIds: ["root", "child"] },
          byteLength: 1000,
          sha256: "d".repeat(64),
        };
        const retained = {
          version: 1,
          checkpoint: original,
          selection: {
            effectSets: [
              {
                id: "origin",
                rootId: "root",
                source: "origin",
                baselineId: "before-origin",
                effectCount: 3,
                executionCount: 2,
              },
              {
                id: "empty",
                rootId: "root",
                source: "authoritative",
                baselineId: "baseline",
                effectCount: 0,
                executionCount: 2,
              },
            ],
          },
          byteLength: 2000,
          sha256: "e".repeat(64),
        };
        const descriptor = {
          version: 1,
          binding: { checkpoint: retained, localCheckpoint: local },
          assetCheckpoint: {
            version: 1,
            binding: { checkpoint: shared, localCheckpoint: local },
            byteLength: 3000,
            sha256: "f".repeat(64),
          },
          byteLength: 4000,
          sha256: "a".repeat(64),
        };
        await client.execute({
          sql: "INSERT INTO local_recovery_retained_assets VALUES(?,?,?,?,?,?)",
          args: [
            identity.workspaceId,
            identity.deviceId,
            identity.epochId,
            identity.checkpointId,
            JSON.stringify(descriptor),
            1,
          ],
        });
      }
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_recovery_retained_assets).toBe(2);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    for (const change of [
      "identity",
      "hash",
      "selection",
      "count",
      "local-identity",
      "local-selection",
    ]) {
      const invalid = structuredClone(source),
        row = invalid.tables.local_recovery_retained_assets[0];
      const descriptor = JSON.parse(String(row.descriptor)),
        local = descriptor.binding.localCheckpoint;
      if (change === "identity") row.checkpoint_id = "other";
      if (change === "hash") descriptor.sha256 = "bad";
      if (change === "selection") descriptor.binding.checkpoint.selection.effectSets.pop();
      if (change === "count") descriptor.binding.checkpoint.selection.effectSets[1].effectCount = 1;
      if (change === "local-identity") local.identity.deviceId = "other";
      if (change === "local-selection") local.selection.effectSetIds = [];
      row.descriptor = JSON.stringify(descriptor);
      await expect(importDbJson(targetUrl, invalid)).rejects.toThrow();
      expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    }
    const { local_recovery_retained_assets: _actions, ...tables } = source.tables;
    await expect(importDbJson(targetUrl, { ...source, tables })).rejects.toThrow(
      "missing table local_recovery_retained_assets",
    );
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(
      (await importDbJson(targetUrl, { ...source, version: 22, tables }))
        .local_recovery_retained_assets,
    ).toBe(0);
    expect(source.tables.local_recovery_retained_assets).toHaveLength(2);
  });

  it("round-trips image staging evidence without reading or installing files", async () => {
    const sourceUrl = await migratedDbUrl("uploads-source.db");
    const targetUrl = await migratedDbUrl("uploads-target.db");
    const client = createClient({ url: sourceUrl });
    try {
      for (const [index, state] of ["pending", "installed", "completed", "abandoned"].entries())
        await client.execute({
          sql: "INSERT INTO local_image_upload(filename,byte_length,sha256,state,created_at,installed_at,completed_at,error,abandoned_at,abandon_reason) VALUES(?,?,?,?,?,?,?,?,?,?)",
          args: [
            `00000000-0000-4000-8000-00000000000${index}.svg`,
            3,
            "a".repeat(64),
            state,
            1,
            state === "installed" || state === "completed" ? 2 : null,
            state === "completed" ? 3 : null,
            state === "abandoned" ? "Original failure" : null,
            state === "abandoned" ? 4 : null,
            state === "abandoned" ? "Reviewed" : null,
          ],
        });
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_image_upload).toBe(4);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    source.tables.local_image_upload[0].filename = "../outside.svg";
    await expect(importDbJson(targetUrl, source)).rejects.toThrow(
      "Invalid local image upload metadata",
    );
    expect((await exportDbJson(targetUrl)).tables.local_image_upload).toHaveLength(4);
    const { local_image_upload: _uploads, ...tables } = source.tables;
    expect(
      (await importDbJson(targetUrl, { ...source, version: 14, tables })).local_image_upload,
    ).toBe(0);
  });

  it("round-trips local file operations whose shared identities are absent", async () => {
    const sourceUrl = await migratedDbUrl("operations-source.db");
    const targetUrl = await migratedDbUrl("operations-target.db");
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute(
        "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('pending','taskspace.claim',1,'missing','missing','local/pending','workspace_relative','pending','{}',1)",
      );
      await client.execute(
        "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,confirmed_at) VALUES('confirmed','taskspace.claim',1,'missing','missing','local/confirmed','workspace_relative','confirmed','{}',1,2)",
      );
      await client.execute(
        "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('file','taskspace.file',1,'missing','missing','local/file.txt','workspace_relative','pending','{}',1)",
      );
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect(source.version).toBe(24);
    expect((await importDbJson(targetUrl, source)).local_file_operation).toBe(3);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    source.tables.local_file_operation[0].path = "../escape";
    await expect(importDbJson(targetUrl, source)).rejects.toThrow("leaves the workspace");
    source.tables.local_file_operation[0].path = "/external";
    source.tables.local_file_operation[0].path_kind = "absolute";
    await expect(importDbJson(targetUrl, source)).rejects.toThrow("--allow-absolute-paths");
    await importDbJson(targetUrl, source, { allowAbsolutePaths: true });
  });

  it("imports version 10 with an empty local operation journal", async () => {
    const sourceUrl = await migratedDbUrl("operations-v10-source.db");
    const targetUrl = await migratedDbUrl("operations-v10-target.db");
    await seedDb(sourceUrl);
    const source = await exportDbJson(sourceUrl);
    const { local_file_operation: _operations, ...tables } = source.tables;
    const legacy = { ...source, version: 10, tables };
    const original = JSON.stringify(legacy);
    expect((await importDbJson(targetUrl, legacy)).local_file_operation).toBe(0);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(JSON.stringify(legacy)).toBe(original);
  });

  it("imports version 11 claim records unchanged without running them", async () => {
    const sourceUrl = await migratedDbUrl("v11-source.db");
    const targetUrl = await migratedDbUrl("v11-target.db");
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute(
        "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('claim','taskspace.claim',1,'missing','missing','local/pending','workspace_relative','pending','{}',1)",
      );
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    const legacy = { ...source, version: 11 };
    const original = JSON.stringify(legacy);
    expect((await importDbJson(targetUrl, legacy)).local_file_operation).toBe(1);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(JSON.stringify(legacy)).toBe(original);
  });

  it("round-trips orphan directory intents and validates their destination before import", async () => {
    const sourceUrl = await migratedDbUrl("directory-source.db");
    const targetUrl = await migratedDbUrl("directory-target.db");
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute({
        sql: "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('directory','taskspace.directory',1,'missing','missing','local/source','workspace_relative','pending',?,1)",
        args: [
          JSON.stringify({
            operation: "move",
            name: "target",
            targetPath: "local/target",
            before: {},
            directory: { dev: "0", ino: "0", markerHash: "a".repeat(64) },
          }),
        ],
      });
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect((await importDbJson(targetUrl, source)).local_file_operation).toBe(1);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    source.tables.local_file_operation[0].intent = JSON.stringify({ targetPath: "../outside" });
    await expect(importDbJson(targetUrl, source)).rejects.toThrow("leaves the workspace");
    const retained = await exportDbJson(targetUrl);
    expect(retained.tables.local_file_operation).toHaveLength(1);
    expect(JSON.parse(String(retained.tables.local_file_operation[0].intent)).targetPath).toBe(
      "local/target",
    );
  });

  it("imports version 12 file journals without executing their callbacks", async () => {
    const sourceUrl = await migratedDbUrl("file-v12-source.db");
    const targetUrl = await migratedDbUrl("file-v12-target.db");
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute(
        "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('file','taskspace.file',1,'missing','missing','local/file.txt','workspace_relative','pending','{}',1)",
      );
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    const legacy = { ...source, version: 12 };
    const original = JSON.stringify(legacy);
    expect((await importDbJson(targetUrl, legacy)).local_file_operation).toBe(1);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(JSON.stringify(legacy)).toBe(original);
  });

  it("imports version 13 journals with empty abandonment fields without mutating the dump", async () => {
    const sourceUrl = await migratedDbUrl("v13-source.db");
    const targetUrl = await migratedDbUrl("v13-target.db");
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute(
        "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('pending','taskspace.directory',1,'missing','missing','local/path','workspace_relative','pending','{}',1)",
      );
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    const legacy = {
      ...source,
      version: 13,
      tables: {
        ...source.tables,
        local_file_operation: source.tables.local_file_operation.map(
          ({ abandoned_at: _at, abandon_reason: _reason, ...row }) => row,
        ),
      },
    };
    const original = JSON.stringify(legacy);
    expect((await importDbJson(targetUrl, legacy)).local_file_operation).toBe(1);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    expect(JSON.stringify(legacy)).toBe(original);
  });

  it("round-trips abandonment evidence and rejects unsafe intermediate layout paths before import", async () => {
    const sourceUrl = await migratedDbUrl("abandoned-source.db");
    const targetUrl = await migratedDbUrl("abandoned-target.db");
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute({
        sql: "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,error,abandoned_at,abandon_reason) VALUES('reviewed','taskspace.directory',1,'missing','missing','local/path','workspace_relative','abandoned',?,1,'Original failure',2,'Reviewed on disk')",
        args: [
          JSON.stringify({
            operation: "layout",
            targetPath: "local/target",
            paths: ["local/path", "local/intermediate", "local/target"],
            before: {},
            directory: {},
          }),
        ],
      });
    } finally {
      client.close();
    }
    const source = await exportDbJson(sourceUrl);
    expect((await importDbJson(targetUrl, source)).local_file_operation).toBe(1);
    expect((await exportDbJson(targetUrl)).tables).toEqual(source.tables);
    const intent = JSON.parse(String(source.tables.local_file_operation[0].intent));
    intent.paths[1] = "../outside";
    source.tables.local_file_operation[0].intent = JSON.stringify(intent);
    await expect(importDbJson(targetUrl, source)).rejects.toThrow("leaves the workspace");
    expect((await exportDbJson(targetUrl)).tables.local_file_operation[0].abandon_reason).toBe(
      "Reviewed on disk",
    );
  });

  it("reads a version 7 dump, which predates scope_area, as having no frames", async () => {
    const sourceUrl = await migratedDbUrl("v7-source.db");
    const targetUrl = await migratedDbUrl("v7-target.db");
    await seedDb(sourceUrl);

    // Version 7 predates `scope_area`, so an absent key means there were no saved frames.
    const dump = await exportDbJson(sourceUrl);
    const legacy = {
      ...dump,
      version: 7,
      tables: { ...legacyTables(dump.tables), scope_area: undefined },
    };
    delete (legacy.tables as Record<string, unknown>).scope_area;

    const counts = await importDbJson(targetUrl, legacy as never);

    expect(counts.scope_area).toBe(0);
    // Restore the other tables when an older dump omits a table.
    expect(counts.card).toBe(2);
    expect(counts.scope_rel).toBe(1);
  });

  it("reads a version 8 dump, which predates inventories, as having nothing stored", async () => {
    const sourceUrl = await migratedDbUrl("v8-source.db");
    const targetUrl = await migratedDbUrl("v8-target.db");
    await seedDb(sourceUrl);

    // Version 8 has neither the `inventory` table nor the two columns it added to `card`.
    const dump = await exportDbJson(sourceUrl);
    const tables: Record<string, unknown> = {
      ...legacyTables(dump.tables),
      card: dump.tables.card.map(({ inventory_id: _id, inventory_slot: _slot, ...row }) => row),
    };
    delete tables.inventory;
    const legacy = { ...dump, version: 8, tables };

    const counts = await importDbJson(targetUrl, legacy as never);

    expect(counts.inventory).toBe(0);
    expect(counts.card).toBe(2);
    const imported = await exportDbJson(targetUrl);
    expect(imported.tables.card.every((row) => row.inventory_id === null)).toBe(true);
  });

  it("still demands the inventory columns from a dump new enough to have them", async () => {
    const sourceUrl = await migratedDbUrl("v9-missing-column.db");
    const targetUrl = await migratedDbUrl("v9-missing-column-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const broken = {
      ...dump,
      tables: {
        ...dump.tables,
        card: dump.tables.card.map(({ inventory_slot: _slot, ...row }) => row),
      },
    };

    await expect(importDbJson(targetUrl, broken as never)).rejects.toThrow(
      "missing column inventory_slot",
    );
  });

  it("refuses a card stored in an inventory the dump does not have", async () => {
    const sourceUrl = await migratedDbUrl("v9-dangling.db");
    const targetUrl = await migratedDbUrl("v9-dangling-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const [first, ...rest] = dump.tables.card;
    const broken = {
      ...dump,
      tables: {
        ...dump.tables,
        card: [{ ...first, inventory_id: "gone", inventory_slot: 0 }, ...rest],
      },
    };

    await expect(importDbJson(targetUrl, broken as never)).rejects.toThrow(
      "references unknown inventory_id gone",
    );
  });

  it("still demands scope_area from a dump old enough to have it", async () => {
    const sourceUrl = await migratedDbUrl("v8-missing-table.db");
    const targetUrl = await migratedDbUrl("v8-missing-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const broken = { ...dump, tables: { ...dump.tables } };
    delete (broken.tables as Record<string, unknown>).scope_area;

    await expect(importDbJson(targetUrl, broken as never)).rejects.toThrow(
      "missing table scope_area",
    );
  });

  it("rejects an export version this build cannot read", async () => {
    const dbUrl = await migratedDbUrl("future.db");
    const dump = { ...(await exportDbJson(dbUrl)), version: 99 };

    await expect(importDbJson(dbUrl, dump)).rejects.toThrow("Unsupported Kozane database export");
  });

  it("rejects invalid export JSON", async () => {
    const dbUrl = await migratedDbUrl("invalid.db");

    await expect(importDbJson(dbUrl, { kind: "other" })).rejects.toThrow(
      "not a Kozane database export",
    );
  });
});

describe("export table list", () => {
  const schemaTables = () =>
    Object.values(schema)
      .filter((value) => is(value, SQLiteTable))
      .map((table) => getTableConfig(table as SQLiteTable));

  /**
   * Verify that exported columns include every declared schema column. Omitting one would
   * silently lose data from the dump.
   */
  it("covers every column of every table in the Drizzle schema", () => {
    const exported = new Map<string, readonly string[]>(
      TABLES.map((table) => [table.name, table.columns]),
    );

    expect([...exported.keys()].sort()).toEqual(
      schemaTables()
        .map((t) => t.name)
        .sort(),
    );
    for (const table of schemaTables()) {
      expect({ table: table.name, columns: [...(exported.get(table.name) ?? [])].sort() }).toEqual({
        table: table.name,
        columns: table.columns.map((column) => column.name).sort(),
      });
    }
  });

  /**
   * Verify that `TABLE_ORDER` includes every schema table and places referenced tables before
   * their dependents. Restore deletes rows in reverse order.
   */
  it("orders every table after the tables its foreign keys point at", () => {
    // Use string keys because Drizzle types table names as strings.
    const position = new Map<string, number>(TABLES.map((table, index) => [table.name, index]));

    expect([...position.keys()].sort()).toEqual(
      schemaTables()
        .map((t) => t.name)
        .sort(),
    );

    for (const table of schemaTables()) {
      for (const reference of table.foreignKeys) {
        const target = getTableConfig(reference.reference().foreignTable).name;
        // A self-reference needs a separate ordering rule. The current schema has none.
        expect(target).not.toBe(table.name);
        expect({
          table: table.name,
          references: target,
          writtenAfterIt: position.get(table.name)! > position.get(target)!,
        }).toEqual({ table: table.name, references: target, writtenAfterIt: true });
      }
    }
  });
});

/**
 * Verify that invalid foreign keys identify the offending row. SQLite's constraint error does
 * not identify it.
 */
describe("import reference validation", () => {
  let sequence = 0;

  async function seededDump() {
    const sourceUrl = await migratedDbUrl(`refs-source-${sequence++}.db`);
    await seedDb(sourceUrl);
    return exportDbJson(sourceUrl);
  }

  async function expectRejectedImport(
    corrupt: (tables: Awaited<ReturnType<typeof seededDump>>["tables"]) => void,
    message: string | RegExp,
  ) {
    const dump = await seededDump();
    corrupt(dump.tables);

    const targetUrl = await migratedDbUrl(`refs-target-${sequence++}.db`);
    await seedDb(targetUrl);

    await expect(importDbJson(targetUrl, dump)).rejects.toThrow(message);

    // Reject invalid references before deleting existing rows to preserve the target workspace.
    const after = await exportDbJson(targetUrl);
    expect(after.tables.card).toHaveLength(2);
    expect(after.tables.namespace).toHaveLength(1);
  }

  it("rejects a card on an unknown layer", async () => {
    await expectRejectedImport((tables) => {
      tables.card[0].layer_id = "layer-missing";
    }, "card card-1: references unknown layer_id layer-missing");
  });

  it("rejects a card stored in another namespace's inventory", async () => {
    await expectRejectedImport((tables) => {
      tables.namespace.push({ ...tables.namespace[0], id: "namespace-2", is_default: 0 });
      tables.inventory[0].namespace_id = "namespace-2";
      Object.assign(tables.card[0], { inventory_id: "inventory-1", inventory_slot: 0 });
    }, "card card-1: inventory_id inventory-1 belongs to another namespace");
  });

  it("rejects a card with an inventory but no slot", async () => {
    await expectRejectedImport((tables) => {
      Object.assign(tables.card[0], { inventory_id: "inventory-1", inventory_slot: null });
    }, "card card-1: inventory_id and inventory_slot must be set together");
  });

  it("rejects two cards in one inventory slot", async () => {
    await expectRejectedImport((tables) => {
      for (const card of tables.card)
        Object.assign(card, { inventory_id: "inventory-1", inventory_slot: 3 });
    }, "inventory inventory-1 slot 3 is taken");
  });

  it("rejects a layer in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.layer[0].namespace_id = "namespace-missing";
    }, "layer layer-1: references unknown namespace_id namespace-missing");
  });

  it("rejects a warp in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.warp[0].namespace_id = "namespace-missing";
    }, "warp warp-1: references unknown namespace_id namespace-missing");
  });

  it("rejects a partition in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.partition[0].namespace_id = "namespace-missing";
    }, "partition partition-1: references unknown namespace_id namespace-missing");
  });

  it("rejects a card in an unknown partition", async () => {
    await expectRejectedImport((tables) => {
      tables.card[0].partition_id = "partition-missing";
    }, "card card-1: references unknown partition_id partition-missing");
  });

  it("rejects a card in an unknown taskspace", async () => {
    await expectRejectedImport((tables) => {
      tables.card[0].taskspace_id = "taskspace-missing";
    }, "card card-1: references unknown taskspace_id taskspace-missing");
  });

  it("rejects a taskspace in an unknown scope", async () => {
    await expectRejectedImport((tables) => {
      tables.taskspace[0].scope_id = "scope-missing";
    }, "taskspace taskspace-1: references unknown scope_id scope-missing");
  });

  it("rejects a glue_rel naming an unknown card", async () => {
    await expectRejectedImport((tables) => {
      tables.glue_rel[0].card_id = "card-missing";
    }, "glue_rel: references unknown card_id card-missing");
  });

  it("rejects a scope_rel naming an unknown scope", async () => {
    await expectRejectedImport((tables) => {
      tables.scope_rel[0].scope_id = "scope-missing";
    }, "scope_rel: references unknown scope_id scope-missing");
  });

  it("rejects two namespaces claiming to be the default", async () => {
    await expectRejectedImport((tables) => {
      tables.namespace.push({ ...tables.namespace[0], id: "namespace-2", is_default: 1 });
      tables.namespace[0].is_default = 1;
    }, "more than one namespace is marked as the default");
  });

  it("rejects a namespace without a default partition", async () => {
    await expectRejectedImport((tables) => {
      tables.partition[0].is_default = 0;
    }, "namespace namespace-1: must have exactly one default partition, found 0");
  });

  it("rejects a namespace without a default layer", async () => {
    await expectRejectedImport((tables) => {
      tables.layer[0].is_default = 0;
    }, "namespace namespace-1: must have exactly one default layer, found 0");
  });

  it("rejects a namespace with two default layers", async () => {
    await expectRejectedImport((tables) => {
      tables.layer.push({ ...tables.layer[0], id: "layer-2", name: "Second" });
    }, "namespace namespace-1: must have exactly one default layer, found 2");
  });

  it("rejects a taskspace in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.taskspace[0].namespace_id = "namespace-missing";
    }, "taskspace taskspace-1: references unknown namespace_id namespace-missing");
  });

  it("rejects a glue_rel naming an unknown glue group", async () => {
    await expectRejectedImport((tables) => {
      tables.glue_rel[0].glue_id = "glue-missing";
    }, "glue_rel: references unknown glue_id glue-missing");
  });

  it("rejects a scope_rel naming an unknown card", async () => {
    await expectRejectedImport((tables) => {
      tables.scope_rel[0].card_id = "card-missing";
    }, "scope_rel: references unknown card_id card-missing");
  });

  it("rejects a scope_area on an unknown scope", async () => {
    await expectRejectedImport((tables) => {
      tables.scope_area[0].scope_id = "scope-missing";
    }, "scope_area scope-area-1: references unknown scope_id scope-missing");
  });

  it("rejects a scope_area in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.scope_area[0].namespace_id = "namespace-missing";
    }, "scope_area scope-area-1: references unknown namespace_id namespace-missing");
  });

  // Taskspaces may have no namespace, and cards may have no taskspace.
  it("accepts the nullable references that are allowed to be null", async () => {
    const dump = await seededDump();
    dump.tables.taskspace[0].namespace_id = null;
    dump.tables.taskspace[0].scope_id = null;
    const targetUrl = await migratedDbUrl(`refs-target-${sequence++}.db`);
    await expect(importDbJson(targetUrl, dump)).resolves.toMatchObject({ taskspace: 1 });
  });

  it("rejects a workspace-relative taskspace path that leaves the workspace", async () => {
    await expectRejectedImport((tables) => {
      tables.taskspace_local[0].path = "../../elsewhere";
    }, "taskspace taskspace-1: workspace-relative path leaves the workspace");
  });

  it("rejects an unknown taskspace path kind", async () => {
    await expectRejectedImport((tables) => {
      tables.taskspace_local[0].path_kind = "remote";
    }, 'taskspace taskspace-1: unknown path kind "remote"');
  });

  it("rejects absolute taskspace paths unless allowed", async () => {
    await expectRejectedImport((tables) => {
      tables.taskspace_local[0].path = "/home/someone";
      tables.taskspace_local[0].path_kind = "absolute";
    }, /--allow-absolute-paths/);

    const dump = await seededDump();
    dump.tables.taskspace_local[0].path = "/home/someone";
    dump.tables.taskspace_local[0].path_kind = "absolute";
    const targetUrl = await migratedDbUrl(`refs-target-${sequence++}.db`);
    await expect(
      importDbJson(targetUrl, dump, { allowAbsolutePaths: true }),
    ).resolves.toMatchObject({ taskspace: 1 });
  });

  // `card.layer_id` is NOT NULL, so a null here would otherwise reach SQLite as a
  // constraint failure rather than as the missing reference it is.
  it("reports a null layer_id as an unknown reference rather than a constraint failure", async () => {
    await expectRejectedImport((tables) => {
      tables.card[0].layer_id = null;
    }, "card card-1: references unknown layer_id null");
  });
});

describe("import batching", () => {
  // Exercise multiple insert batches, including a table wider than the batch size, to verify
  // the generated `VALUES` shape.
  it("restores a table spanning several insert batches", async () => {
    const sourceUrl = await migratedDbUrl("batch-source.db");
    const targetUrl = await migratedDbUrl("batch-target.db");
    await seedDb(sourceUrl);

    const client = createClient({ url: sourceUrl });
    const cardCount = 512;
    try {
      await client.batch(
        Array.from({ length: cardCount }, (_unused, index) => ({
          sql: "INSERT INTO card (id, partition_id, layer_id, content, pos_x, pos_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())",
          args: [`bulk-${index}`, "partition-1", "layer-1", `card ${index}`, index, index * 2],
        })),
        "write",
      );
    } finally {
      client.close();
    }

    const dump = await exportDbJson(sourceUrl);
    // The two seeded cards plus the bulk ones.
    expect(dump.tables.card).toHaveLength(cardCount + 2);

    await expect(importDbJson(targetUrl, dump)).resolves.toMatchObject({
      card: cardCount + 2,
    });

    // Check that the round trip preserves row values and order.
    const imported = await exportDbJson(targetUrl);
    expect(imported.tables.card).toEqual(dump.tables.card);
  });
});

describe("export refuses what JSON cannot carry", () => {
  it("names the table and column of a value it cannot represent", async () => {
    const dbUrl = await migratedDbUrl("export-blob.db");
    await seedDb(dbUrl);
    const client = createClient({ url: dbUrl });
    try {
      // SQLite can store a BLOB in a TEXT column. The client returns it as an `ArrayBuffer`,
      // which the exporter must handle as an invalid value.
      await client.execute({
        sql: "UPDATE card SET content = ? WHERE id = ?",
        args: [new Uint8Array([0xde, 0xad, 0xbe, 0xef]), "card-1"],
      });
    } finally {
      client.close();
    }

    await expect(exportDbJson(dbUrl)).rejects.toThrow(
      "Unsupported database value for card.content",
    );
  });

  it("names the table when the client refuses to hand a value over at all", async () => {
    const dbUrl = await migratedDbUrl("export-bigint.db");
    await seedDb(dbUrl);
    const client = createClient({ url: dbUrl });
    try {
      // Beyond 2^53. The client reads integer columns as JavaScript numbers, so this fails
      // during the SELECT rather than in `rowToJson`, with a message that names neither
      // the table nor the column.
      await client.execute({
        sql: "UPDATE card SET z_index = ? WHERE id = ?",
        args: [9007199254740993n, "card-1"],
      });
    } finally {
      client.close();
    }

    await expect(exportDbJson(dbUrl)).rejects.toThrow("Failed to read table card for export");
  });
});

describe("import rejects a malformed dump", () => {
  let sequence = 0;
  const target = () => migratedDbUrl(`malformed-${sequence++}.db`);

  async function wellFormed() {
    const sourceUrl = await migratedDbUrl(`malformed-source-${sequence++}.db`);
    await seedDb(sourceUrl);
    return exportDbJson(sourceUrl);
  }

  it("rejects a dump that is not an object at all", async () => {
    await expect(importDbJson(await target(), "not a dump")).rejects.toThrow(
      "Import file must contain a JSON object",
    );
  });

  it("rejects null, which is an object by typeof and nothing by shape", async () => {
    await expect(importDbJson(await target(), null)).rejects.toThrow(
      "Import file must contain a JSON object",
    );
  });

  it("rejects a dump with no exportedAt", async () => {
    const dump = await wellFormed();
    await expect(importDbJson(await target(), { ...dump, exportedAt: undefined })).rejects.toThrow(
      "Import file is missing exportedAt",
    );
  });

  it("rejects a dump with no migrations block", async () => {
    const dump = await wellFormed();
    await expect(importDbJson(await target(), { ...dump, migrations: null })).rejects.toThrow(
      "Import file is missing migrations",
    );
  });

  it("rejects a migrations block missing a key", async () => {
    const dump = await wellFormed();
    await expect(
      importDbJson(await target(), { ...dump, migrations: { applied: "0001" } }),
    ).rejects.toThrow("Import file has invalid migrations");
  });

  it("rejects a migrations block whose values are the wrong type", async () => {
    const dump = await wellFormed();
    await expect(
      importDbJson(await target(), { ...dump, migrations: { applied: 1, latest: null } }),
    ).rejects.toThrow("Import file has invalid migrations");
  });

  it("rejects a dump with no tables block", async () => {
    const dump = await wellFormed();
    await expect(importDbJson(await target(), { ...dump, tables: null })).rejects.toThrow(
      "Import file is missing tables",
    );
  });

  it("rejects a table that is not an array", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: {} };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Import file is missing table card",
    );
  });

  it("rejects a row that is not an object", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: ["not a row"] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Invalid row 0 in table card",
    );
  });

  it("rejects a row that is an array, which is an object by typeof", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: [[]] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Invalid row 0 in table card",
    );
  });

  it("names the row and column of a missing column", async () => {
    const dump = await wellFormed();
    const { z_index: _dropped, ...withoutZIndex } = dump.tables.card[0];
    const tables = { ...dump.tables, card: [withoutZIndex] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Row 0 in table card is missing column z_index",
    );
  });

  it("names the row and column of a value JSON cannot carry", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: [{ ...dump.tables.card[0], content: { a: 1 } }] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Invalid value for card.content at row 0",
    );
  });

  it("reports the second row by its own index", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: [dump.tables.card[0], "not a row"] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Invalid row 1 in table card",
    );
  });
});

describe("import rolls back a dump SQLite refuses", () => {
  it("leaves the target workspace exactly as it was", async () => {
    // All references pass validation, but the insert violates `scope_name_nonempty`. Verify
    // that rollback restores the rows deleted earlier in the transaction.
    const sourceUrl = await migratedDbUrl("rollback-source.db");
    await seedDb(sourceUrl);
    const dump = await exportDbJson(sourceUrl);
    dump.tables.scope[0].name = "";

    const targetUrl = await migratedDbUrl("rollback-target.db");
    await seedDb(targetUrl);

    await expect(importDbJson(targetUrl, dump)).rejects.toThrow();

    // A failed import must preserve existing data.
    const after = await exportDbJson(targetUrl);
    expect(after.tables.card).toHaveLength(2);
    expect(after.tables.namespace).toHaveLength(1);
    expect(after.tables.scope).toHaveLength(1);
    expect(after.tables.scope[0].name).toBe("Planning");
    expect(after.tables.glue_rel).toHaveLength(2);
    expect(after.tables.scope_area).toHaveLength(1);
  });

  it("leaves the database usable for the import that follows", async () => {
    // Rollback must release the transaction so a later import can succeed.
    const sourceUrl = await migratedDbUrl("rollback-retry-source.db");
    await seedDb(sourceUrl);
    const good = await exportDbJson(sourceUrl);
    const bad = {
      ...good,
      tables: { ...good.tables, scope: [{ ...good.tables.scope[0], name: "" }] },
    };

    const targetUrl = await migratedDbUrl("rollback-retry-target.db");
    await seedDb(targetUrl);

    await expect(importDbJson(targetUrl, bad)).rejects.toThrow();
    await expect(importDbJson(targetUrl, good)).resolves.toMatchObject({ card: 2 });
  });
});

describe("stringifyDbJson", () => {
  const dump = {
    kind: "kozane.db.json" as const,
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    migrations: { applied: null, latest: null },
    tables: {},
  };

  it("indents by default and ends with a newline", () => {
    const text = stringifyDbJson(dump as never);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "kind"');
  });

  it("writes one line when asked not to indent, still newline-terminated", () => {
    const text = stringifyDbJson(dump as never, false);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().includes("\n")).toBe(false);
  });

  it("round-trips through JSON.parse", () => {
    expect(JSON.parse(stringifyDbJson(dump as never))).toEqual(dump);
  });
});

describe("dumpLimitWarnings", () => {
  const limits = { contentMax: 100, canvasWidth: 1000, canvasHeight: 800 };

  const card = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
    id,
    partition_id: "b-1",
    layer_id: "l-1",
    content: "short",
    pos_x: 10,
    pos_y: 20,
    ...over,
  });

  const dumpOf = (tables: Record<string, unknown[]>) => ({
    tables: { namespace: [], partition: [], layer: [], scope: [], taskspace: [], ...tables },
  });

  it("says nothing about a dump within every limit", () => {
    expect(dumpLimitWarnings(dumpOf({ card: [card("c-1")] }), limits)).toEqual([]);
  });

  it("names the cards whose text is past this workspace's contentMax", () => {
    const dump = dumpOf({
      card: [card("c-1"), card("c-2", { content: "x".repeat(101) })],
    });
    const [warning, ...rest] = dumpLimitWarnings(dump, limits);
    expect(rest).toEqual([]);
    expect(warning).toContain("1 card longer");
    expect(warning).toContain("ui.contentMax of 100");
    expect(warning).toContain("c-2");
    expect(warning).not.toContain("c-1");
  });

  it("names the cards sitting off this workspace's canvas, in either direction", () => {
    const dump = dumpOf({
      card: [
        card("inside"),
        card("too-far-right", { pos_x: 1001 }),
        card("too-far-down", { pos_y: 801 }),
        card("negative", { pos_x: -1 }),
      ],
    });
    const [warning] = dumpLimitWarnings(dump, limits);
    expect(warning).toContain("3 cards positioned outside");
    expect(warning).toContain("1000×800");
    expect(warning).toContain("too-far-right");
    expect(warning).not.toContain("inside");
  });

  // The canvas boundary is inclusive.
  it("counts the far edge as on the board", () => {
    const dump = dumpOf({ card: [card("edge", { pos_x: 1000, pos_y: 800 })] });
    expect(dumpLimitWarnings(dump, limits)).toEqual([]);
  });

  it("names over-long names by table, since every named thing shares one limit", () => {
    const long = "n".repeat(256);
    const dump = dumpOf({
      card: [],
      namespace: [{ id: "ns-1", name: long }],
      layer: [{ id: "l-1", name: "Base" }],
      scope: [{ id: "s-1", name: long }],
    });
    const [warning] = dumpLimitWarnings(dump, limits);
    expect(warning).toContain("2 names longer than the 255-character limit");
    expect(warning).toContain("namespace ns-1");
    expect(warning).toContain("scope s-1");
    expect(warning).not.toContain("l-1");
  });

  it("stops naming rows after a few, and still counts them all", () => {
    const dump = dumpOf({
      card: Array.from({ length: 9 }, (_, i) => card(`c-${i}`, { content: "x".repeat(101) })),
    });
    const [warning] = dumpLimitWarnings(dump, limits);
    expect(warning).toContain("9 cards longer");
    expect(warning).toContain("and 4 more");
    expect(warning).not.toContain("c-8");
  });

  it("reports every condition a dump trips, one line each", () => {
    const dump = dumpOf({
      card: [card("c-1", { content: "x".repeat(101) }), card("c-2", { pos_x: 9999 })],
      scope: [{ id: "s-1", name: "n".repeat(256) }],
    });
    expect(dumpLimitWarnings(dump, limits)).toHaveLength(3);
  });

  // Warnings run after commit. Invalid configuration must not turn a successful restore into
  // an error.
  it("reads a shape it was not given as nothing to warn about", () => {
    expect(dumpLimitWarnings(null, limits)).toEqual([]);
    expect(dumpLimitWarnings("not a dump", limits)).toEqual([]);
    expect(dumpLimitWarnings({}, limits)).toEqual([]);
    expect(dumpLimitWarnings({ tables: null }, limits)).toEqual([]);
    expect(dumpLimitWarnings({ tables: { card: "nope" } }, limits)).toEqual([]);
    expect(dumpLimitWarnings({ tables: { card: [null, 7, "x"] } }, limits)).toEqual([]);
  });
});

import { openDb } from "../../db/client.js";
import { nodeCommitRevision } from "../../db/tx.js";
it("advances the shared Node revision once after importing every table", async () => {
  const url = await migratedDbUrl("tracked-import.db");
  await seedDb(url);
  const dump = await exportDbJson(url);
  const { db, close } = await openDb(url);
  try {
    const before = nodeCommitRevision(db);
    await importDbJson(url, dump);
    expect(nodeCommitRevision(db)).toEqual({ nonce: before.nonce, revision: before.revision + 1 });
    const invalid = structuredClone(dump);
    // This passes structural validation but fails the database's nonempty-name constraint.
    invalid.tables.scope[0].name = "";
    const committed = nodeCommitRevision(db);
    await expect(importDbJson(url, invalid)).rejects.toThrow();
    expect(nodeCommitRevision(db)).toEqual(committed);
    expect((await exportDbJson(url)).tables).toEqual(dump.tables);
  } finally {
    close();
  }
});
