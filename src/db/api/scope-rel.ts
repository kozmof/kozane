import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { partitionTable, cardTable, glueRelTable, scopeRelTable, scopeTable } from "../schema.js";
import type { NeedsDB, NeedsNamespace, NeedsScope, Card, ScopeRel } from "./types.js";
import { assertFound, columnCount, type BatchRefusal } from "./utils.js";
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

type AddScopeRels = NeedsScope & { cardIds: string[] };

/**
 * Files many cards into one scope, in {@link chunked} statements rather than one per card.
 * Idempotent the way {@link addScopeRel} is.
 *
 * Unlike {@link addScopeMembers} this checks no ownership and opens no transaction, so it
 * suits a caller that has already established both — `kozane card squash`, which inserts
 * the cards it is filing in the same transaction a moment earlier.
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
 * Refused two ways, and a caller that could only be told "no" reported the wrong one. Both
 * of these used to answer `false` for a missing scope and for foreign cards alike, and the
 * DELETE route worded that as "Some cards do not belong to this namespace" — said of a
 * request whose cards were perfectly fine and whose *scope* was the thing that did not
 * exist.
 */
export type ScopeMemberResult = { ok: true } | BatchRefusal<"foreign-cards" | "foreign-scope">;

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

    // Chunked, where this used to build one statement from every card the request named:
    // two columns a row against `BATCH_MAX` ids is twice the parameter budget a single
    // insert is allowed. `addScopeRels` beside it was already doing this.
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
 * The scope memberships of a named handful of cards, for a caller that already holds the
 * ids and knows how many there are. Not for the board: see {@link getScopeRelsByNamespace}.
 */
export async function getScopeRelsByCards({
  db,
  cardIds,
}: GetScopeRelsByCards): Promise<ScopeRel[]> {
  if (cardIds.length === 0) return [];
  return db.select().from(scopeRelTable).where(inArray(scopeRelTable.cardId, cardIds));
}

/**
 * Every scope membership of a namespace's cards, selected by the namespace rather than by
 * naming them. The counterpart to `getGlueRelsByNamespace`, for the same reason and on the
 * table that grows fastest — see the note there.
 *
 * Reaches `scope_rel` through `scope_rel_card`, which the schema declares precisely because
 * the primary key leads with `scope_id` and so cannot answer a lookup by card.
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
