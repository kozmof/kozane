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
  console.log(`Generated ${manifest.length} schema objects from bundled migrations`);
} finally {
  client.close();
}
