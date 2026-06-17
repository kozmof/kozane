import { scopeTable, scopeRelTable, cardTable, bundleTable } from "../schema.js";
import { and, eq, inArray } from "drizzle-orm";
import type { NeedsDB, NeedsScope, Scope } from "./types.js";
import { assertFound } from "./utils.js";
import { withTx, type DB } from "../tx.js";

export async function getAllScopes({ db }: NeedsDB): Promise<Scope[]> {
  return db.select().from(scopeTable);
}

type GetScope = NeedsDB & { scopeId: string };
export async function getScope({ db, scopeId }: GetScope): Promise<Scope | undefined> {
  return db.select().from(scopeTable).where(eq(scopeTable.id, scopeId)).get();
}

type AddScope = NeedsDB & { name: string };
export async function addScope({ db, name }: AddScope): Promise<string> {
  const [row] = await db.insert(scopeTable).values({ name }).returning({ id: scopeTable.id });
  return row.id;
}

type UpdateScopeName = NeedsScope & { name: string };
export async function updateScopeName({ db, scopeId, name }: UpdateScopeName): Promise<void> {
  const updated = await db
    .update(scopeTable)
    .set({ name })
    .where(eq(scopeTable.id, scopeId))
    .returning({ id: scopeTable.id });
  assertFound(updated, `Scope scopeId=${scopeId}`);
}

type DeleteScope = NeedsDB & { scopeId: string };
export async function deleteScope({ db, scopeId }: DeleteScope): Promise<void> {
  const deleted = await db
    .delete(scopeTable)
    .where(eq(scopeTable.id, scopeId))
    .returning({ id: scopeTable.id });
  assertFound(deleted, `Scope scopeId=${scopeId}`);
}

/**
 * Removes this project's cards from a scope. If the scope has no remaining
 * members across any project, deletes it entirely (FK cascade nullifies
 * working_copy.scope_id). Returns false when the scope does not exist.
 */
export async function deleteScopeFromProject({
  db,
  projectId,
  scopeId,
}: {
  db: DB;
  projectId: string;
  scopeId: string;
}): Promise<boolean> {
  return withTx(db, async (tx) => {
    const scope = await tx
      .select({ id: scopeTable.id })
      .from(scopeTable)
      .where(eq(scopeTable.id, scopeId))
      .get();
    if (!scope) return false;

    const projectCardSubq = tx
      .select({ id: cardTable.id })
      .from(cardTable)
      .innerJoin(
        bundleTable,
        and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
      );
    await tx
      .delete(scopeRelTable)
      .where(and(eq(scopeRelTable.scopeId, scopeId), inArray(scopeRelTable.cardId, projectCardSubq)));

    const stillHasMembers = await tx
      .select({ cardId: scopeRelTable.cardId })
      .from(scopeRelTable)
      .where(eq(scopeRelTable.scopeId, scopeId))
      .get();

    if (!stillHasMembers) {
      await tx.delete(scopeTable).where(eq(scopeTable.id, scopeId));
    }

    return true;
  });
}
