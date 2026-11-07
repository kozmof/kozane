import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createDatabaseAdapter, createServiceContext } from "@kozane/core/database";
import { schemaVersion, migrations } from "@kozane/core/migrations";
import * as schema from "@kozane/core/schema";
import { validateCandidate } from "./validation.ts";
import { summarizeView } from "./view-summary.ts";
import { readCorpus } from "./read-corpus.mjs";
import { migrationCompatibility, planCorpusCompatibility } from "./corpus-compatibility.ts";
import { decodeRecovery, RecoveryCopyError } from "./recovery.ts";
import { namespaces, tags, map } from "@kozane/core/services";
const clientModule = process.argv.includes("--client") ? await import("@kozane/client") : undefined;
const sqlite = await sqlite3InitModule();
let checked = 0,
  incompatible = 0;
const cohorts = readCorpus(process.argv[2]);
const migrationIds = migrations.map((record) => record.id);
planCorpusCompatibility(
  cohorts.map((cohort) => cohort.migrationId),
  schemaVersion,
  migrationIds,
);
for (const cohort of cohorts) {
  const policy = migrationCompatibility(cohort.migrationId, schemaVersion, migrationIds);
  for (const fixture of cohort.fixtures) {
    if (policy === "incompatible") {
      const saved = JSON.stringify({
        schemaVersion: cohort.migrationId,
        savedAt: 0,
        db: readFileSync(join(cohort.directory, fixture.file)).toString("base64"),
      });
      assert.throws(
        () => decodeRecovery(saved, schemaVersion),
        (error) => error instanceof RecoveryCopyError && error.reason === "incompatible",
      );
      incompatible += fixture.expected.length;
      continue;
    }
    sqlite.capi.sqlite3_js_posix_create_file(
      "/retained.db",
      new Uint8Array(readFileSync(join(cohort.directory, fixture.file))),
    );
    const engine = new sqlite.oo1.DB("/retained.db", "w");
    engine.exec("PRAGMA foreign_keys=ON");
    const handle = drizzle(
      async (sql, args, method) => {
        const rows = [];
        engine.exec({ sql, bind: args, rowMode: "array", resultRows: rows });
        return { rows: method === "get" ? rows[0] : rows };
      },
      { schema },
    );
    const db = createDatabaseAdapter(handle, {
      read: async (operation) => {
        engine.exec("BEGIN DEFERRED");
        try {
          const result = await operation(handle);
          engine.exec("COMMIT");
          return result;
        } catch (error) {
          engine.exec("ROLLBACK");
          throw error;
        }
      },
      write: async () => {
        throw new Error("Corpus validation must be read-only");
      },
    });
    try {
      const before = engine.selectValue("SELECT total_changes()");
      for (const expected of fixture.expected) {
        const view = await validateCandidate(db, { namespaceId: expected.namespaceId });
        assert.deepEqual(await summarizeView(view), expected.view, `${cohort.id}/${fixture.id}`);
        if (clientModule) {
          const context = createServiceContext();
          const rows = await namespaces.list(db, context);
          const client = new clientModule.StaticBackend({
            namespaces: rows,
            snapshots: view.kind === "selected" ? [view.snapshot.snapshot] : [],
            tags: await tags.view(db, context),
            map: await map.get(db, context),
          });
          assert.deepEqual(await client.namespaces.list(), rows);
          await client.tags.get();
          await client.map.get();
          if (view.kind === "selected") {
            const snapshot = await client.snapshot(view.namespaceId);
            assert.equal(snapshot.status, "changed");
            assert.deepEqual(
              await summarizeView({
                ...view,
                snapshot: { namespace: view.snapshot.namespace, snapshot: snapshot.data },
              }),
              expected.view,
              `Packed client rejected or changed ${cohort.id}/${fixture.id}`,
            );
          }
        }
        checked++;
      }
      assert.equal(engine.selectValue("SELECT total_changes()"), before);
    } finally {
      engine.close();
    }
  }
}
console.log(
  `Retained compatibility corpus passed ${checked} same-ID view outcomes and ${incompatible} earlier-ID envelope outcomes with packed core, wasm${clientModule ? " and client" : ""}.`,
);
