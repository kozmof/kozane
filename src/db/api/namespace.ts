import { partitionTable, cardTable, glueRelTable, namespaceTable } from "../schema.js";
import { and, asc, eq } from "drizzle-orm";
import type { NeedsDB, Namespace } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";
import { withTx, type DB, type Tx } from "../tx.js";
import { addPartition } from "./partition.js";
import { addLayer } from "./layer.js";
import { DEFAULT_PARTITION_NAME, DEFAULT_LAYER_NAME } from "../../lib/constants.js";
// Safe to import here, unlike from card.ts (see the note above `deleteNamespaceCards`):
// glue.ts reaches into card.ts, and card.ts does not reach back into this module.
import { dissolveOrphanGlueGroupsInTx } from "./glue.js";

export async function getAllNamespaces({ db }: NeedsDB): Promise<Namespace[]> {
  return db.select().from(namespaceTable);
}

type GetNamespace = NeedsDB & { namespaceId: string };
export async function getNamespace({
  db,
  namespaceId,
}: GetNamespace): Promise<Namespace | undefined> {
  return db.select().from(namespaceTable).where(eq(namespaceTable.id, namespaceId)).get();
}

type AddNamespace = NeedsDB & { name: string; isDefault?: boolean };
export async function addNamespace({ db, name, isDefault = false }: AddNamespace): Promise<string> {
  assertNameWithinLimit(name, "Namespace name");
  const [row] = await db
    .insert(namespaceTable)
    .values({ name, isDefault })
    .returning({ id: namespaceTable.id });
  return row.id;
}

type CreateNamespace = { db: DB; name: string; isDefault?: boolean };
/**
 * A namespace along with the default partition and layer a usable canvas needs. Written in one
 * transaction: a namespace that came out of a half-finished create would have no partition to
 * put a card in and no layer to put it on, and the browser page assumes both exist.
 */
export async function createNamespace({
  db,
  name,
  isDefault = false,
}: CreateNamespace): Promise<string> {
  return withTx(db, async (tx) => {
    const namespaceId = await addNamespace({ db: tx, name, isDefault });
    await addPartition({ db: tx, namespaceId, name: DEFAULT_PARTITION_NAME, isDefault: true });
    await addLayer({ db: tx, namespaceId, name: DEFAULT_LAYER_NAME, isDefault: true });
    return namespaceId;
  });
}

export async function setDefaultNamespace({
  db,
  namespaceId,
}: {
  db: DB;
  namespaceId: string;
}): Promise<void> {
  await withTx(db, async (tx) => {
    await tx
      .update(namespaceTable)
      .set({ isDefault: false })
      .where(eq(namespaceTable.isDefault, true));
    const updated = await tx
      .update(namespaceTable)
      .set({ isDefault: true })
      .where(eq(namespaceTable.id, namespaceId))
      .returning({ id: namespaceTable.id });
    assertFound(updated, `Namespace namespaceId=${namespaceId}`);
  });
}

/** The glue groups this namespace's cards belong to, read before the cascade removes them. */
async function namespaceGlueIds(tx: Tx, namespaceId: string): Promise<string[]> {
  const rows = await tx
    .select({ glueId: glueRelTable.glueId })
    .from(glueRelTable)
    .innerJoin(cardTable, eq(glueRelTable.cardId, cardTable.id))
    .innerJoin(
      partitionTable,
      and(
        eq(cardTable.partitionId, partitionTable.id),
        eq(partitionTable.namespaceId, namespaceId),
      ),
    );
  return rows.map((row) => row.glueId);
}

type DeleteNamespace = { db: DB; namespaceId: string };
export async function deleteNamespace({ db, namespaceId }: DeleteNamespace): Promise<void> {
  await withTx(db, async (tx) => {
    const namespace = await tx
      .select()
      .from(namespaceTable)
      .where(eq(namespaceTable.id, namespaceId))
      .get();
    assertFound(namespace ? [namespace] : [], `Namespace namespaceId=${namespaceId}`);

    // Read while the cards still exist: deleting the namespace cascades partitions, cards, and
    // their glue_rel rows away, and a `glue` row is referenced by nothing, so afterwards
    // there is no way left to tell which groups the namespace emptied out.
    const glueIds = await namespaceGlueIds(tx, namespaceId);
    await tx.delete(namespaceTable).where(eq(namespaceTable.id, namespaceId));
    // Groups the namespace did not empty entirely are left alone by the sweep, so a group
    // that somehow spans two namespaces keeps the members it still has.
    await dissolveOrphanGlueGroupsInTx({ db: tx, glueIds });

    if (namespace?.isDefault) {
      // Ordered so the workspace promotes the same namespace twice running. uuidv7 ids sort
      // by creation, which makes this the oldest surviving namespace.
      const replacement = await tx
        .select({ id: namespaceTable.id })
        .from(namespaceTable)
        .orderBy(asc(namespaceTable.id))
        .limit(1)
        .get();
      if (replacement) {
        await tx
          .update(namespaceTable)
          .set({ isDefault: true })
          .where(eq(namespaceTable.id, replacement.id));
      }
    }
  });
}

type UpdateNamespaceName = NeedsDB & { namespaceId: string; name: string };
export async function updateNamespaceName({
  db,
  namespaceId,
  name,
}: UpdateNamespaceName): Promise<void> {
  assertNameWithinLimit(name, "Namespace name");
  const updated = await db
    .update(namespaceTable)
    .set({ name })
    .where(eq(namespaceTable.id, namespaceId))
    .returning({ id: namespaceTable.id });
  assertFound(updated, `Namespace namespaceId=${namespaceId}`);
}
