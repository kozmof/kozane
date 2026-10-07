import {
  scopeTable,
  scopeRelTable,
  scopeAreaTable,
  cardTable,
  partitionTable,
  taskspaceTable,
} from "../schema.js";
import {
  and,
  count,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { union } from "drizzle-orm/sqlite-core";
import type { NeedsDB, NeedsNamespace, NeedsScope, Scope } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";
import { withTx, type DB } from "../tx.js";

/**
 * List all workspace scopes for the CLI. Use {@link getScopesInNamespace} for a board's
 * scoped view.
 */
export async function getAllScopes({ db }: NeedsDB): Promise<Scope[]> {
  return db.select().from(scopeTable);
}

/**
 * Return scopes visible on a namespace's board. A scope is visible when it has a card or
 * taskspace in that namespace, or when no card or taskspace anywhere refers to it.
 *
 * Unused scopes appear on every board so a newly created scope remains visible before anything
 * is assigned to it. `deleteScopeFromNamespace` uses the same condition to allow removal.
 *
 * Use one statement for a consistent read with fewer database round trips. Correlated `EXISTS`
 * queries use the existing scope relation, taskspace, and primary-key indexes. `NOT IN` would
 * mishandle nullable `taskspace.scope_id` values. The uncorrelated card query also required
 * SQLite to build a temporary covering index in measured query plans.
 */
export async function getScopesInNamespace({ db, namespaceId }: NeedsNamespace): Promise<Scope[]> {
  const cardOfThisNamespace = db
    .select({ present: sql`1` })
    .from(scopeRelTable)
    .innerJoin(cardTable, eq(cardTable.id, scopeRelTable.cardId))
    .innerJoin(partitionTable, eq(partitionTable.id, cardTable.partitionId))
    .where(
      and(eq(scopeRelTable.scopeId, scopeTable.id), eq(partitionTable.namespaceId, namespaceId)),
    );

  // A taskspace with no namespace is unplaced rather than another namespace's (see the note on
  // `taskspaceTable`), so it counts here on every board rather than none.
  const taskspaceOfThisNamespace = db
    .select({ present: sql`1` })
    .from(taskspaceTable)
    .where(
      and(
        eq(taskspaceTable.scopeId, scopeTable.id),
        or(eq(taskspaceTable.namespaceId, namespaceId), isNull(taskspaceTable.namespaceId)),
      ),
    );

  // A scope framed on this board is drawn here whether or not anything is in the frame yet.
  // Without this branch a scope given an area and no cards would vanish from the board that
  // has its frame on it, which is the one board that must keep it.
  const areaOfThisNamespace = db
    .select({ present: sql`1` })
    .from(scopeAreaTable)
    .where(
      and(eq(scopeAreaTable.scopeId, scopeTable.id), eq(scopeAreaTable.namespaceId, namespaceId)),
    );

  const anyCard = db
    .select({ present: sql`1` })
    .from(scopeRelTable)
    .where(eq(scopeRelTable.scopeId, scopeTable.id));

  const anyTaskspace = db
    .select({ present: sql`1` })
    .from(taskspaceTable)
    .where(eq(taskspaceTable.scopeId, scopeTable.id));

  // A scope framed on any board is placed.
  const anyArea = db
    .select({ present: sql`1` })
    .from(scopeAreaTable)
    .where(eq(scopeAreaTable.scopeId, scopeTable.id));

  return db
    .select()
    .from(scopeTable)
    .where(
      or(
        exists(cardOfThisNamespace),
        exists(taskspaceOfThisNamespace),
        exists(areaOfThisNamespace),
        and(notExists(anyCard), notExists(anyTaskspace), notExists(anyArea)),
      ),
    );
}

export type ScopeNamespaceUsage = { scopeId: string; namespaceId: string };

/**
 * Find namespaces that use each scope through card membership or an attached taskspace.
 *
 * Omit unused scopes and taskspaces without a namespace. Deduplicate in SQL so each scope and
 * namespace pair appears once. This workspace-wide scan runs for the CLI, outside the board
 * polling path.
 */
export async function getScopeNamespaceUsage({ db }: NeedsDB): Promise<ScopeNamespaceUsage[]> {
  const fromCards = db
    .select({ scopeId: scopeRelTable.scopeId, namespaceId: partitionTable.namespaceId })
    .from(scopeRelTable)
    .innerJoin(cardTable, eq(cardTable.id, scopeRelTable.cardId))
    .innerJoin(partitionTable, eq(partitionTable.id, cardTable.partitionId));

  // Exclude taskspaces missing either scope or namespace. The casts reflect the WHERE
  // clause's non-null guarantees.
  const fromTaskspaces = db
    .select({
      scopeId: sql<string>`${taskspaceTable.scopeId}`.as("scope_id"),
      namespaceId: sql<string>`${taskspaceTable.namespaceId}`.as("namespace_id"),
    })
    .from(taskspaceTable)
    .where(and(isNotNull(taskspaceTable.scopeId), isNotNull(taskspaceTable.namespaceId)));

  // Use UNION to deduplicate scope and namespace pairs across card and taskspace links in one
  // consistent read.
  return union(fromCards, fromTaskspaces);
}

/** One scope's reach into one partition, and how many cards make it. See
 *  {@link getScopePartitionUsage}. */
export type ScopePartitionUsage = { scopeId: string; partitionId: string; cards: number };

/**
 * Count each scope's cards by partition for the workspace map's links.
 *
 * Taskspace links have no partition and are supplied separately by {@link
 * getScopeNamespaceUsage}. Group counts in SQL to return one row per scope and partition
 * pair. This scans workspace memberships on page load, outside board polling.
 */
export async function getScopePartitionUsage({ db }: NeedsDB): Promise<ScopePartitionUsage[]> {
  return db
    .select({
      scopeId: scopeRelTable.scopeId,
      partitionId: partitionTable.id,
      cards: count(scopeRelTable.cardId),
    })
    .from(scopeRelTable)
    .innerJoin(cardTable, eq(cardTable.id, scopeRelTable.cardId))
    .innerJoin(partitionTable, eq(partitionTable.id, cardTable.partitionId))
    .groupBy(scopeRelTable.scopeId, partitionTable.id);
}

type GetScope = NeedsDB & { scopeId: string };
export async function getScope({ db, scopeId }: GetScope): Promise<Scope | undefined> {
  return db.select().from(scopeTable).where(eq(scopeTable.id, scopeId)).get();
}

type AddScope = NeedsDB & { name: string };
export async function addScope({ db, name }: AddScope): Promise<string> {
  assertNameWithinLimit(name, "Scope name");
  const [row] = await db.insert(scopeTable).values({ name }).returning({ id: scopeTable.id });
  return row.id;
}

type UpdateScopeName = NeedsScope & { name: string };
export async function updateScopeName({ db, scopeId, name }: UpdateScopeName): Promise<void> {
  assertNameWithinLimit(name, "Scope name");
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

/** Delete scopes only when no cards, taskspaces, or frames reference them. */
export async function deleteScopeFromNamespace({
  db,
  namespaceId,
  scopeId,
}: {
  db: DB;
  namespaceId: string;
  scopeId: string;
}): Promise<boolean> {
  return withTx(db, async (tx) => {
    const scope = await tx
      .select({ id: scopeTable.id })
      .from(scopeTable)
      .where(eq(scopeTable.id, scopeId))
      .get();
    if (!scope) return false;

    const namespaceCardSubq = tx
      .select({ id: cardTable.id })
      .from(cardTable)
      .innerJoin(
        partitionTable,
        and(
          eq(cardTable.partitionId, partitionTable.id),
          eq(partitionTable.namespaceId, namespaceId),
        ),
      );
    await tx
      .delete(scopeRelTable)
      .where(
        and(eq(scopeRelTable.scopeId, scopeId), inArray(scopeRelTable.cardId, namespaceCardSubq)),
      );

    // Remove this board's frames with its memberships so polling does not return the scope
    // again.
    await tx
      .delete(scopeAreaTable)
      .where(and(eq(scopeAreaTable.scopeId, scopeId), eq(scopeAreaTable.namespaceId, namespaceId)));

    const stillHasCards = await tx
      .select({ cardId: scopeRelTable.cardId })
      .from(scopeRelTable)
      .where(eq(scopeRelTable.scopeId, scopeId))
      .get();

    const stillHasTaskspaces = stillHasCards
      ? undefined
      : await tx
          .select({ id: taskspaceTable.id })
          .from(taskspaceTable)
          .where(eq(taskspaceTable.scopeId, scopeId))
          .get();

    // Frames on other boards keep the scope alive.
    const stillHasAreas =
      stillHasCards || stillHasTaskspaces
        ? undefined
        : await tx
            .select({ id: scopeAreaTable.id })
            .from(scopeAreaTable)
            .where(eq(scopeAreaTable.scopeId, scopeId))
            .get();

    if (!stillHasCards && !stillHasTaskspaces && !stillHasAreas) {
      await tx.delete(scopeTable).where(eq(scopeTable.id, scopeId));
    }

    return true;
  });
}
