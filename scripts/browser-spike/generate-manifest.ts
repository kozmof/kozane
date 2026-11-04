import { readMigrationFiles } from "drizzle-orm/migrator";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { writeFile } from "node:fs/promises";
import { schemaManifest } from "./schema-manifest";
const client = createClient({ url: ":memory:" });
try {
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  const manifest = await schemaManifest(async (sql) =>
    (await client.execute(sql)).rows.map((row) => Array.from(row)),
  );
  await writeFile("tmp/browser-spike/schema-manifest.json", JSON.stringify(manifest, null, 2));
  const historyTable = await client.execute(
    "SELECT sql FROM sqlite_schema WHERE name = '__drizzle_migrations'",
  );
  await writeFile(
    "tmp/browser-spike/parity-fixture.json",
    JSON.stringify({
      migrations: readMigrationFiles({ migrationsFolder: "drizzle" }),
      historyTableSql: historyTable.rows[0][0],
      manifest,
      history: (
        await client.execute(
          "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at",
        )
      ).rows.map((row) => Array.from(row)),
    }),
  );
  console.log(`Generated ${manifest.length} schema objects from bundled migrations`);
} finally {
  client.close();
}
