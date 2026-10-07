import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { partitionTable, cardTable, glueRelTable, scopeRelTable, scopeTable } from "../schema.js";
import type { NeedsDB, NeedsNamespace, NeedsScope, Card, ScopeRel } from "./types.js";
import { assertFound, columnCount, type BatchResult } from "./utils.js";
import { cardsBelongToNamespace } from "./card.js";
import { withTx, type DB } from "../tx.js";
import { chunked } from "../../lib/constants.js";

type ScopeRelKey = NeedsScope & { cardId: string };

export async function getAllCardsByScope({ db, scopeId }: NeedsScope): Promise<Card[]> {
  return db
    .select(getTableColumns(cardTable))
    .from(cardTable)
    .innerJoin(scopeRelTable, eq(scopeRelTable.cardId, cardTable.id))
    .where(eq(scopeRelTable.scopeId, scopeId));
}

export type CardWithPartitionName = Card & { partitionName: string; glueId: string | null };

export async function getCardsByScopeWithPartitionName({
  db,
  scopeId,
}: NeedsScope): Promise<CardWithPartitionName[]> {
  return db
    .select({
      ...getTableColumns(cardTable),
      partitionName: partitionTable.name,
      glueId: glueRelTable.glueId,
    })
    .from(cardTable)
    .innerJoin(scopeRelTable, eq(scopeRelTable.cardId, cardTable.id))
    .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
    .leftJoin(glueRelTable, eq(glueRelTable.cardId, cardTable.id))
    .where(eq(scopeRelTable.scopeId, scopeId));
}

export async function addScopeRel({ db, scopeId, cardId }: ScopeRelKey): Promise<void> {
  // Ignore duplicate scope/card pairs.
  await db.insert(scopeRelTable).values({ scopeId, cardId }).onConflictDoNothing();
}

export async function removeScopeRel({ db, scopeId, cardId }: ScopeRelKey): Promise<void> {
  const deleted = await db
    .delete(scopeRelTable)
    .where(and(eq(scopeRelTable.scopeId, scopeId), eq(scopeRelTable.cardId, cardId)))
    .returning({ scopeId: scopeRelTable.scopeId });
  assertFound(deleted, `ScopeRel scopeId=${scopeId} cardId=${cardId}`);
}

type AddScopeRels = NeedsScope & { cardIds: string[] };

/**
 * Add scope memberships idempotently in {@link chunked} statements. The caller must validate
 * ownership and provide a transaction, as the squash operation does.
 */
export async function addScopeRels({ db, scopeId, cardIds }: AddScopeRels): Promise<void> {
  for (const batch of chunked(cardIds))
    await db
      .insert(scopeRelTable)
      .values(batch.map((cardId) => ({ scopeId, cardId })))
      .onConflictDoNothing();
}

type AddScopeMembers = { db: DB; scopeId: string; namespaceId: string; cardIds: string[] };

/**
 * Distinguish a missing scope from cards outside the namespace so routes can report the
 * correct failure.
 */
export type ScopeMemberResult = BatchResult<"foreign-cards" | "foreign-scope">;

/** Bulk-adds cards to a scope, after verifying the scope and every card belong here. */
export async function addScopeMembers({
  db,
  scopeId,
  namespaceId,
  cardIds,
}: AddScopeMembers): Promise<ScopeMemberResult> {
  return withTx(db, async (tx) => {
    const scope = await tx
      .select({ id: scopeTable.id })
      .from(scopeTable)
      .where(eq(scopeTable.id, scopeId))
      .get();
    if (!scope) return { ok: false, reason: "foreign-scope" };

    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds });
    if (!owned.ok) return owned;

    // Chunk memberships within the parameter limit, allowing two columns per row.
    for (const batch of chunked([...new Set(cardIds)], {
      columnsPerRow: columnCount(scopeRelTable),
    }))
      await tx
        .insert(scopeRelTable)
        .values(batch.map((cardId) => ({ scopeId, cardId })))
        .onConflictDoNothing();

    return { ok: true };
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

type RemoveScopeMembersFromNamespace = {
  db: DB;
  scopeId: string;
  cardIds: string[];
  namespaceId: string;
};
/** Bulk-removes cards from a scope, after verifying the scope and every card belong here. */
export async function removeScopeMembersFromNamespace({
  db,
  scopeId,
  namespaceId,
  cardIds,
}: RemoveScopeMembersFromNamespace): Promise<ScopeMemberResult> {
  return withTx(db, async (tx) => {
    const scope = await tx
      .select({ id: scopeTable.id })
      .from(scopeTable)
      .where(eq(scopeTable.id, scopeId))
      .get();
    if (!scope) return { ok: false, reason: "foreign-scope" };

    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds });
    if (!owned.ok) return owned;

    await removeScopeMembers({ db: tx, scopeId, cardIds });
    return { ok: true };
  });
}

type GetScopeRelsByCards = NeedsDB & { cardIds: string[] };

/**
 * Get memberships for a known set of card IDs. For board queries, use {@link
 * getScopeRelsByNamespace}.
 */
export async function getScopeRelsByCards({
  db,
  cardIds,
}: GetScopeRelsByCards): Promise<ScopeRel[]> {
  if (cardIds.length === 0) return [];
  return db.select().from(scopeRelTable).where(inArray(scopeRelTable.cardId, cardIds));
}

/**
 * Read all scope memberships for a namespace using joins, as `getGlueRelsByNamespace` does.
 * The `scope_rel_card` index supports lookup by card because the primary key begins with
 * `scope_id`.
 */
export async function getScopeRelsByNamespace({
  db,
  namespaceId,
}: NeedsNamespace): Promise<ScopeRel[]> {
  return db
    .select(getTableColumns(scopeRelTable))
    .from(scopeRelTable)
    .innerJoin(cardTable, eq(cardTable.id, scopeRelTable.cardId))
    .innerJoin(partitionTable, eq(partitionTable.id, cardTable.partitionId))
    .where(eq(partitionTable.namespaceId, namespaceId));
}
