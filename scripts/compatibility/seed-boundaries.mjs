import assert from "node:assert/strict";
import { createServiceContext } from "@kozane/core/database";
import { namespaces, cards, snapshot } from "@kozane/core/services";
import { RECOVERY_DB_MAX_BYTES as MAX_BYTES } from "./recovery.ts";
/** Fixture-only metadata transformations and public-service data at the recovery byte limit. */
export async function seedBoundaries(database, retain) {
  const context = createServiceContext();
  async function namespace(db, name) {
    const ns = await namespaces.create(db, context, { name });
    const view = await snapshot.get(db, context, ns.id);
    return { ns, partitionId: view.snapshot.partitions[0].id };
  }
  await database("normalized-schema", async (db, engine, query) => {
    const { ns, partitionId } = await namespace(db, "Schema normalization 日本語");
    await cards.create(db, context, ns.id, {
      partitionId,
      content: "Accepted formatting and SQLite-owned statistics",
    });
    // Preserve every migrated SQL token. Only add whitespace and comments to persisted definitions.
    const objects = await query(
      "SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
    );
    await query("PRAGMA writable_schema=ON");
    try {
      for (const [name, sql] of objects) {
        const formatted = String(sql).replace(
          /^CREATE\s+/,
          "CREATE /* retained corpus formatting */\n  ",
        );
        assert.notEqual(formatted, sql);
        await query("UPDATE sqlite_schema SET sql=? WHERE name=?", [formatted, name]);
      }
    } finally {
      await query("PRAGMA writable_schema=OFF");
    }
    await query("ANALYZE");
    assert.ok((await query("SELECT name FROM sqlite_schema WHERE name='sqlite_stat1'")).length);
    await retain(db, engine, "normalized-schema", [{ kind: "selected" }]);
  });
  await database("recovery-limit", async (db, engine, query) => {
    const { ns, partitionId } = await namespace(db, "Exact recovery boundary");
    const pageSize = Number((await query("PRAGMA page_size"))[0][0]);
    assert.equal(MAX_BYTES % pageSize, 0);
    const targetPages = MAX_BYTES / pageSize;
    await query(`PRAGMA max_page_count=${targetPages}`);
    const created = [];
    const full = (error) => {
      for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++)
        if (cause.code === "SQLITE_FULL" || cause.resultCode === 13 || cause.rawCode === 13)
          return true;
      return false;
    };
    for (let count = 0; count < 2000; count++) {
      const pages = Number((await query("PRAGMA page_count"))[0][0]);
      if (pages === targetPages) break;
      assert.ok(pages < targetPages);
      const content = `Boundary ${count} ` + "界".repeat(targetPages - pages > 16 ? 5000 : 30);
      try {
        const card = await cards.create(db, context, ns.id, { partitionId, content });
        created.push({ id: card.id, content });
      } catch (error) {
        if (!full(error)) throw error;
        let grew = false;
        for (const card of created) {
          const content = card.content + "a".repeat(pageSize);
          if (content.length > context.contentMax) continue;
          try {
            await cards.update(db, context, ns.id, card.id, { content });
            card.content = content;
            grew = true;
            break;
          } catch (error) {
            if (!full(error)) throw error;
          }
        }
        assert.ok(grew, "Public service data could not reach the recovery boundary");
      }
    }
    assert.equal(Number((await query("PRAGMA page_count"))[0][0]) * pageSize, MAX_BYTES);
    await retain(db, engine, "recovery-limit", [{ kind: "selected" }]);
  });
}
