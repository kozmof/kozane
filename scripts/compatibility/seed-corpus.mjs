import { createServiceContext } from "@kozane/core/database";
import { namespaces, cards, scopes, snapshot } from "@kozane/core/services";
/** Seed the same public-service scenarios through each supported producer driver. */
export async function seedCorpus(database, retain) {
  const context = createServiceContext();
  await database("empty", async (db, engine) =>
    retain(db, engine, "empty", [{ kind: "empty" }, { namespaceId: "absent-id", kind: "missing" }]),
  );
  await database("sole", async (db, engine) => {
    const ns = await namespaces.create(db, context, { name: "単一 namespace 😀" });
    const initial = await snapshot.get(db, context, ns.id);
    const partitionId = initial.snapshot.partitions[0].id;
    const card = await cards.create(db, context, ns.id, {
      partitionId,
      content: "Reload recovery 日本語 😀\n:corpus:unicode",
    });
    await cards.update(db, context, ns.id, card.id, { width: 240 });
    await cards.update(db, context, ns.id, card.id, { width: null });
    await cards.create(db, context, ns.id, {
      partitionId,
      content: "界".repeat(context.contentMax),
    });
    await retain(db, engine, "sole", [
      { kind: "selected" },
      { namespaceId: ns.id, kind: "selected" },
      { namespaceId: "absent-id", kind: "missing" },
    ]);
  });
  await database("multiple", async (db, engine) => {
    const a = await namespaces.create(db, context, { name: "Alpha" }),
      b = await namespaces.create(db, context, { name: "Beta 日本語" });
    const shared = await scopes.create(db, context, { name: "Shared across namespaces" });
    for (const ns of [a, b]) {
      const initial = await snapshot.get(db, context, ns.id);
      await cards.create(db, context, ns.id, {
        partitionId: initial.snapshot.partitions[0].id,
        scopeId: shared.id,
        content: `Cross-namespace ${ns.name}`,
      });
    }
    await retain(db, engine, "multiple", [
      { kind: "selection_required" },
      { namespaceId: a.id, kind: "selected" },
      { namespaceId: b.id, kind: "selected" },
      { namespaceId: "absent-id", kind: "missing" },
    ]);
    await namespaces.setDefault(db, context, b.id);
    await retain(db, engine, "default", [
      { kind: "selected" },
      { namespaceId: a.id, kind: "selected" },
    ]);
  });
}
