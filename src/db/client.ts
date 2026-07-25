import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { resolve } from "node:path";
import { getDBURL } from "./internal/config.js";
import * as schema from "./schema.js";
import type { DB } from "./tx.js";

export type { DB, Tx, AnyDB } from "./tx.js";
export { withTx } from "./tx.js";

type CreateDbOptions = { initialProjectName?: string };

export async function createDb(url: string, options: CreateDbOptions = {}): Promise<DB> {
  const client = createClient({ url });
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema });

  // An in-memory database starts empty on every server run. Migrate it through
  // this long-lived client so its schema remains available for the process lifetime.
  if (url === ":memory:" || url === "file::memory:?cache=shared") {
    const migrationsFolder = resolve(process.cwd(), "drizzle");
    await migrate(db, { migrationsFolder });

    if (options.initialProjectName) {
      const [project] = await db
        .insert(schema.projectTable)
        .values({ name: options.initialProjectName, isDefault: true })
        .returning({ id: schema.projectTable.id });
      await db.insert(schema.bundleTable).values({
        projectId: project.id,
        name: "General",
        isDefault: true,
      });
    }
  }

  return db as unknown as DB;
}

let _dbPromise: Promise<DB> | null = null;

export async function getDb(): Promise<DB> {
  if (!_dbPromise) {
    _dbPromise = createDb(getDBURL(), {
      initialProjectName: process.env.KOZANE_MEMORY_PROJECT_NAME,
    }).catch((e) => {
      _dbPromise = null;
      throw e;
    });
  }
  return _dbPromise;
}

export function resetDb(): void {
  _dbPromise = null;
}
