import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { bundleTable, cardTable, glueRelTable, scopeRelTable, scopeTable } from "../schema.js";
import type { NeedsDB, NeedsScope, Card, ScopeRel } from "./types.js";
import { assertFound } from "./utils.js";
import { withTx, type DB } from "../tx.js";

type ScopeRelKey = NeedsScope & { cardId: string };

export async function getAllCardsByScope({ db, scopeId }: NeedsScope): Promise<Card[]> {
  return db
    .select(getTableColumns(cardTable))
    .from(cardTable)
    .innerJoin(scopeRelTable, eq(scopeRelTable.cardId, cardTable.id))
    .where(eq(scopeRelTable.scopeId, scopeId));
}

export type CardWithBundleName = Card & { bundleName: string; glueId: string | null };

export async function getCardsByScopeWithBundleName({
  db,
  scopeId,
}: NeedsScope): Promise<CardWithBundleName[]> {
  return db
    .select({
      ...getTableColumns(cardTable),
      bundleName: bundleTable.name,
      glueId: glueRelTable.glueId,
    })
    .from(cardTable)
    .innerJoin(scopeRelTable, eq(scopeRelTable.cardId, cardTable.id))
    .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
    .leftJoin(glueRelTable, eq(glueRelTable.cardId, cardTable.id))
    .where(eq(scopeRelTable.scopeId, scopeId));
}

export async function addScopeRel({ db, scopeId, cardId }: ScopeRelKey): Promise<void> {
  // Idempotent: silently ignores duplicate (scopeId, cardId) pairs
  await db.insert(scopeRelTable).values({ scopeId, cardId }).onConflictDoNothing();
}

export async function removeScopeRel({ db, scopeId, cardId }: ScopeRelKey): Promise<void> {
  const deleted = await db
    .delete(scopeRelTable)
    .where(and(eq(scopeRelTable.scopeId, scopeId), eq(scopeRelTable.cardId, cardId)))
    .returning({ scopeId: scopeRelTable.scopeId });
  assertFound(deleted, `ScopeRel scopeId=${scopeId} cardId=${cardId}`);
}

type AddScopeMembers = { db: DB; scopeId: string; projectId: string; cardIds: string[] };
/** Bulk-adds cards to a scope. Returns false if any cardId doesn't belong to projectId. */
export async function addScopeMembers({
  db,
  scopeId,
  projectId,
  cardIds,
}: AddScopeMembers): Promise<boolean> {
  return withTx(db, async (tx) => {
    const found = await tx
      .select({ id: cardTable.id })
      .from(cardTable)
      .innerJoin(
        bundleTable,
        and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
      )
      .where(inArray(cardTable.id, cardIds));

    if (found.length !== cardIds.length) return false;

    await tx
      .insert(scopeRelTable)
      .values(found.map(({ id: cardId }) => ({ scopeId, cardId })))
      .onConflictDoNothing();

    return true;
  });
}

type RemoveScopeMembers = NeedsScope & { cardIds: string[] };
export async function removeScopeMembers({
  db,
  scopeId,
  cardIds,
}: RemoveScopeMembers): Promise<void> {
  await db
    .delete(scopeRelTable)
    .where(and(eq(scopeRelTable.scopeId, scopeId), inArray(scopeRelTable.cardId, cardIds)));
}

type RemoveScopeMembersFromProject = RemoveScopeMembers & { projectId: string };
/** Bulk-removes cards from a scope. Returns false if scope not found or any cardId doesn't belong to projectId. */
export async function removeScopeMembersFromProject({
  db,
  scopeId,
  projectId,
  cardIds,
}: RemoveScopeMembersFromProject): Promise<boolean> {
  const scope = await db
    .select({ id: scopeTable.id })
    .from(scopeTable)
    .where(eq(scopeTable.id, scopeId))
    .get();
  if (!scope) return false;

  const found = await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .innerJoin(
      bundleTable,
      and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
    )
    .where(inArray(cardTable.id, cardIds));

  if (found.length !== cardIds.length) return false;

  await removeScopeMembers({ db, scopeId, cardIds });
  return true;
}

type GetScopeRelsByCards = NeedsDB & { cardIds: string[] };
export async function getScopeRelsByCards({
  db,
  cardIds,
}: GetScopeRelsByCards): Promise<ScopeRel[]> {
  if (cardIds.length === 0) return [];
  return db.select().from(scopeRelTable).where(inArray(scopeRelTable.cardId, cardIds));
}
