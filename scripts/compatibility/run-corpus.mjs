import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createDatabaseAdapter } from "@kozane/core/database";
import { schemaVersion } from "@kozane/core/migrations";
import * as schema from "@kozane/core/schema";
import { validateCandidate } from "./validation.ts";
import { summarizeView } from "./view-summary.ts";
import { readCorpus } from "./read-corpus.mjs";
const sqlite = await sqlite3InitModule();
let checked = 0;
for (const cohort of readCorpus(process.argv[2])) {
  assert.equal(
    cohort.migrationId,
    schemaVersion,
    "A new migration ID needs explicit incompatible-corpus expectations",
  );
  for (const fixture of cohort.fixtures) {
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
        return { rows: method === "get" ? (rows[0] ?? []) : rows };
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
        checked++;
      }
      assert.equal(engine.selectValue("SELECT total_changes()"), before);
    } finally {
      engine.close();
    }
  }
}
console.log(
  `Retained compatibility corpus passed ${checked} view outcomes with packed core and wasm.`,
);
