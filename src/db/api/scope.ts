import { scopeTable, projectScopeRelTable, scopeRelTable, cardTable, bundleTable } from "../schema.js";
import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import type { NeedsDB, NeedsProject, NeedsScope, Scope } from "./types.js";
import { assertFound } from "./utils.js";
import { withTx, type DB } from "../tx.js";

// Scopes are cross-project by design. getAllScopes returns every scope in the DB regardless of
// project, which grows unbounded in multi-project workspaces. Prefer getScopesByProject for
// page loads. getAllScopes is still useful for admin/CLI operations or a future "browse all scopes"
// UI that lets users attach an existing scope from another project to the current one.
export async function getAllScopes({ db }: NeedsDB): Promise<Scope[]> {
  return db.select().from(scopeTable);
}

/** Returns only scopes explicitly associated with the given project via project_scope_rel. */
export async function getScopesByProject({ db, projectId }: NeedsProject): Promise<Scope[]> {
  return db
    .selectDistinct(getTableColumns(scopeTable))
    .from(scopeTable)
    .innerJoin(projectScopeRelTable, eq(projectScopeRelTable.scopeId, scopeTable.id))
    .where(eq(projectScopeRelTable.projectId, projectId));
}

type AddProjectScopeRel = NeedsProject & { scopeId: string };
export async function addProjectScopeRel({
  db,
  projectId,
  scopeId,
}: AddProjectScopeRel): Promise<void> {
  await db.insert(projectScopeRelTable).values({ projectId, scopeId }).onConflictDoNothing();
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
 * Removes a scope from a specific project's view. Deletes scope_rel rows for
 * cards belonging to this project. If no other project references the scope,
 * deletes the scope itself (FK cascade clears remaining scope_rel rows and
 * nullifies working_copy.scope_id). Returns false if the scope was not
 * associated with this project.
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
    const removed = await tx
      .delete(projectScopeRelTable)
      .where(
        and(
          eq(projectScopeRelTable.projectId, projectId),
          eq(projectScopeRelTable.scopeId, scopeId),
        ),
      )
      .returning({ scopeId: projectScopeRelTable.scopeId });

    if (removed.length === 0) return false;

    // Remove scope memberships for cards that belong to this project
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

    // If no other project references this scope, delete it entirely.
    // FK cascade handles remaining scope_rel rows and nullifies working_copy.scope_id.
    const stillReferenced = await tx
      .select({ scopeId: projectScopeRelTable.scopeId })
      .from(projectScopeRelTable)
      .where(eq(projectScopeRelTable.scopeId, scopeId))
      .get();

    if (!stillReferenced) {
      await tx.delete(scopeTable).where(eq(scopeTable.id, scopeId));
    }

    return true;
  });
}
