import { expect, it } from "vitest";
import { createTestDB } from "../test-utils/db.js";
import { createServiceContext } from "./context.js";
import { create as createNamespace } from "./namespaces.js";
import { create as createCard } from "./cards.js";
import { getDefaultPartition } from "../db/api/partition.js";
import { view } from "./tags.js";

it("assembles namespace-filtered database tags without filesystem enrichment", async () => {
  const db = await createTestDB();
  const context = createServiceContext();
  const one = await createNamespace(db, context, { name: "One" });
  const two = await createNamespace(db, context, { name: "Two" });
  const cards = [];
  for (const namespace of [one, two]) {
    const partition = await getDefaultPartition({ db, namespaceId: namespace.id });
    cards.push(
      await createCard(db, context, namespace.id, {
        partitionId: partition!.id,
        content: "Tagged :topic",
      }),
    );
  }
  const filtered = await view(db, context, one.id);
  expect(filtered.index.hits).toHaveLength(1);
  expect(filtered.index.hits[0].source).toEqual({ kind: "card", cardId: cards[0].id });
  expect(filtered.index.cardNamespaces[cards[0].id]).toBe(one.id);
  expect(filtered.index.taskspaces).toEqual({});
  expect(filtered.index.missing).toEqual([]);
  expect(filtered.cardPartitions).toHaveLength(1);
  expect((await view(db, context)).index.hits).toHaveLength(2);
});
