import { scopeTable, scopeRelTable, cardTable, bundleTable, taskspaceTable } from "../schema.js";
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
import type { NeedsDB, NeedsProject, NeedsScope, Scope } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";
import { withTx, type DB } from "../tx.js";

/**
 * Every scope in the workspace, whichever project it is being used from. The
 * workspace-wide view — the CLI's `kozane scope list` — rather than the board's; the
 * browser asks {@link getScopesInProject}.
 */
export async function getAllScopes({ db }: NeedsDB): Promise<Scope[]> {
  return db.select().from(scopeTable);
}

/**
 * The scopes one project's board has reason to draw.
 *
 * A scope carries no `project_id` (see the note on `scopeTable`) — it is placed by what
 * refers to it, so this is three conditions rather than a column read:
 *
 * - a card of this project is filed into it, which is the ordinary case;
 * - a taskspace of this project is attached to it, which is how a scope with no cards yet
 *   is still this project's;
 * - or nothing anywhere refers to it at all, which is a scope somebody has just named and
 *   not yet put anything in. The browser creates one that way — `scope add` in the sidebar
 *   takes a name and nothing else — so leaving these out would have a new scope disappear
 *   from the sidebar on the next poll, a second after it was typed.
 *
 * The last one is the same condition `deleteScopeFromProject` treats as disposable, and
 * deliberately so: an unattached scope belongs to nobody, so every project can see it and
 * any project may clear it away. It stops being shared the moment one of them uses it.
 *
 * One statement rather than the four small reads and a JS filter it could also be. Against
 * a local SQLite file a round trip costs more than any of these subqueries does — the four
 * were measured at roughly twice this — so the shape that reads as more work is the cheaper
 * one. It also keeps the answer a single consistent read rather than four that a CLI write
 * could land between.
 *
 * Spelled with EXISTS rather than IN for two separate reasons, both worth keeping:
 * `taskspace.scope_id` is nullable, and `NOT IN` over a subquery that yields a NULL matches
 * no rows at all — and rewriting the card test as an uncorrelated `IN` driven from this
 * project's bundles, which reads like the cheaper shape, measured about half again slower.
 * `EXPLAIN QUERY PLAN` says why: SQLite answers it by building an AUTOMATIC COVERING INDEX
 * over `card` and `scope_rel` on every call, where the correlated form walks
 * `sqlite_autoindex_scope_rel_1` and the primary keys it already has. Both taskspace
 * subqueries lean on `taskspace_scope`, without which they scan the table once per scope.
 */
export async function getScopesInProject({ db, projectId }: NeedsProject): Promise<Scope[]> {
  const cardOfThisProject = db
    .select({ present: sql`1` })
    .from(scopeRelTable)
    .innerJoin(cardTable, eq(cardTable.id, scopeRelTable.cardId))
    .innerJoin(bundleTable, eq(bundleTable.id, cardTable.bundleId))
    .where(and(eq(scopeRelTable.scopeId, scopeTable.id), eq(bundleTable.projectId, projectId)));

  // A taskspace with no project is unplaced rather than another project's (see the note on
  // `taskspaceTable`), so it counts here on every board rather than none.
  const taskspaceOfThisProject = db
    .select({ present: sql`1` })
    .from(taskspaceTable)
    .where(
      and(
        eq(taskspaceTable.scopeId, scopeTable.id),
        or(eq(taskspaceTable.projectId, projectId), isNull(taskspaceTable.projectId)),
      ),
    );

  const anyCard = db
    .select({ present: sql`1` })
    .from(scopeRelTable)
    .where(eq(scopeRelTable.scopeId, scopeTable.id));

  const anyTaskspace = db
    .select({ present: sql`1` })
    .from(taskspaceTable)
    .where(eq(taskspaceTable.scopeId, scopeTable.id));

  return db
    .select()
    .from(scopeTable)
    .where(
      or(
        exists(cardOfThisProject),
        exists(taskspaceOfThisProject),
        and(notExists(anyCard), notExists(anyTaskspace)),
      ),
    );
}

export type ScopeProjectUsage = { scopeId: string; projectId: string };

/**
 * Which projects each scope reaches, by either route that places one: a card of that
 * project filed into it, or a taskspace of that project attached to it.
 *
 * The board narrowed to one project with {@link getScopesInProject}, so this is what
 * answers "where else is this scope used" — `kozane scope list`. A scope missing from the
 * result is used by no project yet; a taskspace with no `project_id` places nothing, since
 * an unassigned taskspace names no project to report.
 *
 * Walks every scope_rel row in the workspace, which is why it is a CLI query and not one
 * the once-a-second poll makes. What crosses back is already the size of the answer
 * rather than the size of the walk: a scope reached by twenty cards of one project is one
 * row, and it is SQLite that collapses the other nineteen.
 */
export async function getScopeProjectUsage({ db }: NeedsDB): Promise<ScopeProjectUsage[]> {
  const fromCards = db
    .select({ scopeId: scopeRelTable.scopeId, projectId: bundleTable.projectId })
    .from(scopeRelTable)
    .innerJoin(cardTable, eq(cardTable.id, scopeRelTable.cardId))
    .innerJoin(bundleTable, eq(bundleTable.id, cardTable.bundleId));

  // Both columns are nullable on `taskspace`; a row missing either places nothing, so it
  // is dropped by the WHERE rather than filtered back out here. The casts are what the
  // WHERE has already established and the column types cannot carry across it.
  const fromTaskspaces = db
    .select({
      scopeId: sql<string>`${taskspaceTable.scopeId}`.as("scope_id"),
      projectId: sql<string>`${taskspaceTable.projectId}`.as("project_id"),
    })
    .from(taskspaceTable)
    .where(and(isNotNull(taskspaceTable.scopeId), isNotNull(taskspaceTable.projectId)));

  // `UNION`, not `UNION ALL`: it deduplicates across both halves at once, which is the whole
  // of what the caller wants. Each half used to be a `SELECT DISTINCT` run as its own query,
  // and the overlap between them — a project reaching one scope by both a card and a
  // taskspace — was then collapsed here with a `Map` keyed by the two ids joined into a
  // string. One statement is the shape the rest of this module argues for (see
  // `getScopesInProject`): against a local file a round trip costs more than the set
  // operation, and it makes the answer one consistent read rather than two a CLI write
  // could land between.
  return union(fromCards, fromTaskspaces);
}

/** One scope's reach into one bundle, and how many cards make it. See
 *  {@link getScopeBundleUsage}. */
export type ScopeBundleUsage = { scopeId: string; bundleId: string; cards: number };

/**
 * Which bundles each scope reaches, and by how many cards.
 *
 * {@link getScopeProjectUsage} one level finer, and for the map page, which draws a scope as
 * a node with a line to every bundle it reaches. A project is the wrong grain for that line:
 * a scope holding cards from two bundles of one project is two lines there, and collapsing
 * them to the project would draw one line to a rectangle that is not what the cards are in.
 *
 * Cards only. A taskspace attaches a scope to a *project* and to no bundle at all, so it
 * cannot produce a row here — which is why the map recovers those from
 * {@link getScopeProjectUsage} and draws them against the project rectangle instead. The two
 * queries are the two ways a scope is placed, and this is the half that has a bundle.
 *
 * What crosses back is the size of the answer rather than the size of the walk, the same
 * property {@link getScopeProjectUsage} has: twenty cards of one bundle filed into one scope
 * is one row, and it is SQLite that collapses the other nineteen. The count is kept rather
 * than discarded because it is what says how much of a scope sits where — a spoke carrying
 * one card and a spoke carrying two hundred are not the same line to draw.
 *
 * Walks every `scope_rel` row in the workspace, so this is a query a page load makes and not
 * one the once-a-second board poll does.
 */
export async function getScopeBundleUsage({ db }: NeedsDB): Promise<ScopeBundleUsage[]> {
  return db
    .select({
      scopeId: scopeRelTable.scopeId,
      bundleId: bundleTable.id,
      cards: count(scopeRelTable.cardId),
    })
    .from(scopeRelTable)
    .innerJoin(cardTable, eq(cardTable.id, scopeRelTable.cardId))
    .innerJoin(bundleTable, eq(bundleTable.id, cardTable.bundleId))
    .groupBy(scopeRelTable.scopeId, bundleTable.id);
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

/**
 * Removes this project's cards from a scope. If nothing anywhere still refers to the
 * scope, deletes it entirely. Returns false when the scope does not exist.
 *
 * "Nothing anywhere" counts taskspaces as well as cards. A scope is cross-project
 * (see the note on `scopeTable`), so this runs on a row another project may be using,
 * and a scope that has been attached to a taskspace but not yet filed any cards into
 * is a scope someone is in the middle of setting up. Left to the card count alone this
 * would delete it out from under them and — through `taskspace.scope_id`'s
 * `onDelete: "set null"` — quietly detach their taskspace on the way out.
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
      .where(
        and(eq(scopeRelTable.scopeId, scopeId), inArray(scopeRelTable.cardId, projectCardSubq)),
      );

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

    if (!stillHasCards && !stillHasTaskspaces) {
      await tx.delete(scopeTable).where(eq(scopeTable.id, scopeId));
    }

    return true;
  });
}
