import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createDatabaseAdapter } from "@kozane/core/database";
import { applyMigrations, schemaVersion } from "@kozane/core/migrations";
import * as schema from "@kozane/core/schema";
import { validateCandidate } from "./validation.ts";
import { summarizeView } from "./view-summary.ts";
import { seedBoundaries } from "./seed-boundaries.mjs";
import { seedCorpus } from "./seed-corpus.mjs";
const output = process.argv[2];
const producer = JSON.parse(readFileSync(process.argv[3], "utf8"));
const fixtures = [];
let engineVersion;
async function database(name, seed) {
  const path = join(output, `${name}.working`);
  const client = createClient({ url: pathToFileURL(path).href });
  const handle = drizzle(client, { schema });
  async function transaction(mode, operation) {
    const tx = await client.transaction(mode);
    try {
      const result = await operation(drizzle(tx, { schema }));
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
  const db = createDatabaseAdapter(handle, {
    read: (operation) => transaction("read", operation),
    write: (operation) => transaction("write", operation),
    migrate: async (prepare) => {
      const plan = await prepare(handle);
      await client.migrate(plan.map(({ sql, args }) => ({ sql, args: [...args] })));
    },
  });
  try {
    await client.execute("PRAGMA journal_mode=DELETE");
    await client.execute("PRAGMA foreign_keys=ON");
    engineVersion = (await client.execute("SELECT sqlite_version() AS version")).rows[0].version;
    await applyMigrations(db);
    await seed(db, { client, path }, async (sql, args = []) =>
      (await client.execute({ sql, args })).rows.map((row) => Array.from(row)),
    );
  } finally {
    client.close();
    rmSync(path, { force: true });
    rmSync(path + "-journal", { force: true });
  }
}
async function retain(db, engine, name, requests) {
  const expected = [];
  for (const request of requests) {
    const view = await validateCandidate(db, { namespaceId: request.namespaceId });
    assert.equal(view.kind, request.kind);
    expected.push({
      ...(request.namespaceId !== undefined ? { namespaceId: request.namespaceId } : {}),
      view: await summarizeView(view),
    });
  }
  const bytes = readFileSync(engine.path);
  assert.ok(bytes.length <= 2_097_152);
  const file = `${name}.sqlite3`;
  writeFileSync(join(output, file), bytes, { flag: "wx" });
  fixtures.push({
    id: name,
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    expected,
  });
}
await (producer.scenarios === "boundaries" ? seedBoundaries : seedCorpus)(database, retain);
// The exact driver version is supplied from the isolated consumer's locked installation.
const version = JSON.parse(readFileSync("package.json", "utf8")).dependencies["@libsql/client"];
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      format: 1,
      migrationId: schemaVersion,
      producer: {
        ...producer,
        driver: {
          package: "@libsql/client",
          version,
          engine: engineVersion,
          adapter: "drizzle/libsql",
          runtime: process.version,
        },
      },
      fixtures,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(
  `Generated ${fixtures.length} retained libsql fixtures through packed public services.`,
);
