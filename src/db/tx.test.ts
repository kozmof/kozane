import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTestDB } from "../test-utils/db.js";
import { withReadTx, withTx } from "./tx.js";
import { namespaceTable } from "./schema.js";
import { addNamespace, getAllNamespaces } from "./api/namespace.js";

/** A test database in WAL mode plus a second client on the same file, as the CLI would be. */
async function twoClients() {
  const path = join(tmpdir(), `kozane-tx-${randomUUID()}.db`);
  const db = await createTestDB(path);
  await db.run(sql`PRAGMA journal_mode = WAL`);
  // A short timeout makes a held write lock fail fast instead of waiting it out.
  const other = createClient({ url: `file:${path}`, timeout: 200 });
  return { db, other };
}

describe("withReadTx", () => {
  it("gives read helpers a handle that write helpers refuse at compile time", async () => {
    const db = await createTestDB();
    const namespaces = await withReadTx(db, async (tx) => {
      // @ts-expect-error A write helper needs `DB | Tx`, not a read transaction.
      void (() => addNamespace({ db: tx, name: "Refused" }));
      return getAllNamespaces({ db: tx });
    });
    expect(namespaces).toEqual([]);
  });

  it("does not block another connection's writes while it reads", async () => {
    const { db, other } = await twoClients();
    try {
      await withReadTx(db, async (tx) => {
        await tx.select().from(namespaceTable);
        await other.execute("INSERT INTO namespace (id, name) VALUES ('n1', 'written')");
      });
      const rows = await db.select().from(namespaceTable);
      expect(rows.map(({ name }) => name)).toEqual(["written"]);
    } finally {
      other.close();
    }
  });

  it("sees one snapshot even when another connection commits during the read", async () => {
    const { db, other } = await twoClients();
    try {
      const counts = await withReadTx(db, async (tx) => {
        const before = await tx.select().from(namespaceTable);
        await other.execute("INSERT INTO namespace (id, name) VALUES ('n1', 'later')");
        const after = await tx.select().from(namespaceTable);
        return [before.length, after.length];
      });
      expect(counts).toEqual([0, 0]);
    } finally {
      other.close();
    }
  });

  it("leaves withTx a write transaction that blocks other writers", async () => {
    const { db, other } = await twoClients();
    try {
      await withTx(db, async (tx) => {
        await tx.select().from(namespaceTable);
        await expect(
          other.execute("INSERT INTO namespace (id, name) VALUES ('n1', 'blocked')"),
        ).rejects.toThrow(/SQLITE_BUSY/);
      });
    } finally {
      other.close();
    }
  });
});
