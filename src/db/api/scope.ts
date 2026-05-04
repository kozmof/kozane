import { scopeTable, workingCopyTable } from "../schema.js";
import { eq, getTableColumns } from "drizzle-orm";
import type { NeedsDB, NeedsProject, NeedsScope, Scope } from "./types.js";
import { assertFound } from "./utils.js";

// Scopes are cross-project by design; use getAllScopes for UI lists that should
// include newly-created scopes even before they have working copies or members.
export async function getAllScopes({ db }: NeedsDB): Promise<Scope[]> {
  return db.select().from(scopeTable);
}

/** Returns only scopes inferred from working copies in the given project. */
export async function getScopesByProject({ db, projectId }: NeedsProject): Promise<Scope[]> {
  return db
    .selectDistinct(getTableColumns(scopeTable))
    .from(scopeTable)
    .innerJoin(workingCopyTable, eq(workingCopyTable.scopeId, scopeTable.id))
    .where(eq(workingCopyTable.projectId, projectId));
}

type GetScope = NeedsDB & { scopeId: string };
export async function getScope({ db, scopeId }: GetScope): Promise<Scope | undefined> {
  return db.select().from(scopeTable).where(eq(scopeTable.id, scopeId)).get();
}

type AddScope = NeedsDB & { name?: string };
export async function addScope({ db, name = "" }: AddScope): Promise<string> {
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
