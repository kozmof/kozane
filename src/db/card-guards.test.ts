import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB, dropCardGuards } from "../test-utils/db.js";
import type { DB } from "./tx.js";

/** One namespace with a partition, a layer, and an inventory, written with raw SQL. */
async function setup(): Promise<DB> {
  const db = await createTestDB();
  await db.run(sql`INSERT INTO namespace (id, name) VALUES ('ns', 'main')`);
  await db.run(sql`INSERT INTO partition (id, namespace_id, name) VALUES ('p', 'ns', 'General')`);
  await db.run(sql`INSERT INTO layer (id, namespace_id, name) VALUES ('l', 'ns', 'Base')`);
  await db.run(sql`INSERT INTO inventory (id, namespace_id) VALUES ('inv', 'ns')`);
  return db;
}

async function insertCard(
  db: DB,
  id: string,
  inventoryId: string | null = null,
  slot: number | null = null,
): Promise<void> {
  await db.run(sql`
    INSERT INTO card (id, partition_id, layer_id, content, inventory_id, inventory_slot, created_at, updated_at)
    VALUES (${id}, 'p', 'l', 'text', ${inventoryId}, ${slot}, 100, 100)
  `);
}

async function placement(db: DB, id: string) {
  return db.get<{ inventory_id: string | null; inventory_slot: number | null }>(
    sql`SELECT inventory_id, inventory_slot FROM card WHERE id = ${id}`,
  );
}

function causeMessages(e: unknown): string {
  return e instanceof Error ? `${e.message} ${causeMessages(e.cause)}` : "";
}

async function expectRefused(write: Promise<unknown>): Promise<void> {
  const e = await write.then(
    () => null,
    (error: unknown) => error,
  );
  expect(causeMessages(e)).toContain("inventory_id and inventory_slot must be set together");
}

describe("card inventory pairing triggers", () => {
  it("refuses an insert with only one inventory column set", async () => {
    const db = await setup();
    await expectRefused(insertCard(db, "a", "inv", null));
    await expectRefused(insertCard(db, "b", null, 3));
    await insertCard(db, "c", "inv", 3);
    await insertCard(db, "d");
    expect(await placement(db, "c")).toEqual({ inventory_id: "inv", inventory_slot: 3 });
  });

  it("refuses an update that sets one column alone", async () => {
    const db = await setup();
    await insertCard(db, "a");
    await expectRefused(db.run(sql`UPDATE card SET inventory_id = 'inv' WHERE id = 'a'`));
    await expectRefused(db.run(sql`UPDATE card SET inventory_slot = 2 WHERE id = 'a'`));
    await insertCard(db, "b", "inv", 1);
    await expectRefused(db.run(sql`UPDATE card SET inventory_slot = NULL WHERE id = 'b'`));
  });

  it("clears the slot when inventory_id alone is cleared", async () => {
    const db = await setup();
    await insertCard(db, "a", "inv", 1);
    await db.run(sql`UPDATE card SET inventory_id = NULL WHERE id = 'a'`);
    expect(await placement(db, "a")).toEqual({ inventory_id: null, inventory_slot: null });
  });

  it("puts cards back on the canvas when their inventory row is deleted directly", async () => {
    const db = await setup();
    await insertCard(db, "a", "inv", 1);
    // The foreign key's `set null` action, rather than `deleteInventory`.
    await db.run(sql`DELETE FROM inventory WHERE id = 'inv'`);
    expect(await placement(db, "a")).toEqual({ inventory_id: null, inventory_slot: null });
  });
});

describe("card timestamp trigger", () => {
  it("stamps an insert that leaves both timestamps at the default", async () => {
    const db = await setup();
    const before = Math.floor(Date.now() / 1000);
    await db.run(
      sql`INSERT INTO card (id, partition_id, layer_id, content) VALUES ('a', 'p', 'l', 'x')`,
    );
    const row = await db.get<{ created_at: number; updated_at: number }>(
      sql`SELECT created_at, updated_at FROM card WHERE id = 'a'`,
    );
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.updated_at).toBe(row.created_at);
  });

  it("gives a missing updated_at the supplied created_at", async () => {
    const db = await setup();
    await db.run(
      sql`INSERT INTO card (id, partition_id, layer_id, content, created_at) VALUES ('a', 'p', 'l', 'x', 500)`,
    );
    expect(await db.get(sql`SELECT created_at, updated_at FROM card WHERE id = 'a'`)).toEqual({
      created_at: 500,
      updated_at: 500,
    });
  });
});

describe("migration 0019", () => {
  it("puts cards with only one inventory column set back on the canvas", async () => {
    const db = await setup();
    await dropCardGuards(db);
    await insertCard(db, "no-slot", "inv", null);
    await insertCard(db, "no-inventory", null, 4);
    await insertCard(db, "stored", "inv", 1);

    const migration = readFileSync(resolve("drizzle/0019_card_guards.sql"), "utf-8");
    for (const statement of migration.split("--> statement-breakpoint"))
      await db.run(sql.raw(statement));

    expect(await placement(db, "no-slot")).toEqual({ inventory_id: null, inventory_slot: null });
    expect(await placement(db, "no-inventory")).toEqual({
      inventory_id: null,
      inventory_slot: null,
    });
    expect(await placement(db, "stored")).toEqual({ inventory_id: "inv", inventory_slot: 1 });
    // The triggers are back.
    await expectRefused(insertCard(db, "late", "inv", null));
  });
});
