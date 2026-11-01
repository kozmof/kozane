import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";
import { openDb } from "./client.js";
import { withTx } from "./tx.js";
import { addNamespace, getAllNamespaces } from "./api/namespace.js";

describe("openDb with an in-memory URL", () => {
  it.each([":memory:", "file::memory:"])("keeps %s data across transactions", async (url) => {
    const { db, close } = await openDb(url);
    try {
      await withTx(db, (tx) => addNamespace({ db: tx, name: "First" }));
      await withTx(db, (tx) => addNamespace({ db: tx, name: "Second" }));
      const names = (await getAllNamespaces({ db })).map(({ name }) => name).sort();
      expect(names).toEqual(["First", "Second"]);
    } finally {
      close();
    }
  });

  it("deletes its temporary file on close", async () => {
    const { db, close } = await openDb(":memory:");
    const [{ file }] = await db.all<{ file: string }>(sql`SELECT file FROM pragma_database_list`);
    expect(existsSync(file)).toBe(true);
    close();
    expect(existsSync(dirname(file))).toBe(false);
  });
});
