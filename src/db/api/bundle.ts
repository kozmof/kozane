import { bundleTable, cardTable } from "../schema.js";
import { and, count, eq } from "drizzle-orm";
import type { NeedsDB, NeedsProject, NeedsProjectBundle, Bundle } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";

export async function getAllBundles({ db, projectId }: NeedsProject): Promise<Bundle[]> {
  return db.select().from(bundleTable).where(eq(bundleTable.projectId, projectId));
}

/** A bundle, and how many cards sit in it. See {@link getBundleCardCounts}. */
export type BundleCardCount = {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  cards: number;
};

/**
 * Every bundle in the workspace, with how many cards it holds.
 *
 * What the map page draws a rectangle from: a bundle's area *is* its card count there, so the
 * number is the geometry rather than a label beside it.
 *
 * A `LEFT JOIN`, and that is the whole of what distinguishes this from the obvious query. An
 * inner join answers with the bundles that have a card in them, which on a page whose subject
 * is what a workspace holds is exactly the wrong set: an empty bundle would not be drawn
 * small, it would not be drawn at all. `count(card.id)` rather than `count(*)` for the same
 * reason — over a left join the latter counts the one all-null row an empty bundle produces
 * and reports it as holding a card.
 *
 * One statement over the workspace rather than one per project, the same argument
 * `getScopeProjectUsage` makes: the map packs every project at once, so the per-project shape
 * is a round trip per rectangle, and the grouping SQLite does here is the grouping the caller
 * would otherwise do in JS over every card id in the database. It rides `card_bundle`, the
 * index the board's poll already needs.
 */
export async function getBundleCardCounts({ db }: NeedsDB): Promise<BundleCardCount[]> {
  return db
    .select({
      id: bundleTable.id,
      projectId: bundleTable.projectId,
      name: bundleTable.name,
      isDefault: bundleTable.isDefault,
      cards: count(cardTable.id),
    })
    .from(bundleTable)
    .leftJoin(cardTable, eq(cardTable.bundleId, bundleTable.id))
    .groupBy(bundleTable.id);
}

type GetBundle = NeedsProjectBundle;
export async function getBundle({
  db,
  projectId,
  bundleId,
}: GetBundle): Promise<Bundle | undefined> {
  // bundleId alone would uniquely identify the row (UUID), but projectId is checked too as a
  // defence-in-depth access boundary so callers cannot reach across project lines via a bare ID.
  return db
    .select()
    .from(bundleTable)
    .where(and(eq(bundleTable.projectId, projectId), eq(bundleTable.id, bundleId)))
    .get();
}

type AddBundle = NeedsProject & { name: string; isDefault?: boolean };
export async function addBundle({
  db,
  projectId,
  name,
  isDefault = false,
}: AddBundle): Promise<string> {
  assertNameWithinLimit(name, "Bundle name");
  const [row] = await db
    .insert(bundleTable)
    .values({ projectId, name, isDefault })
    .returning({ id: bundleTable.id });
  return row.id;
}

export async function getDefaultBundle({
  db,
  projectId,
}: NeedsProject): Promise<Bundle | undefined> {
  return db
    .select()
    .from(bundleTable)
    .where(and(eq(bundleTable.projectId, projectId), eq(bundleTable.isDefault, true)))
    .get();
}

type DeleteBundle = NeedsProjectBundle;
export async function deleteBundle({ db, projectId, bundleId }: DeleteBundle): Promise<void> {
  const deleted = await db
    .delete(bundleTable)
    .where(and(eq(bundleTable.projectId, projectId), eq(bundleTable.id, bundleId)))
    .returning({ id: bundleTable.id });
  assertFound(deleted, `Bundle projectId=${projectId} bundleId=${bundleId}`);
}

type UpdateBundleName = NeedsProjectBundle & { name: string };
export async function updateBundleName({
  db,
  projectId,
  bundleId,
  name,
}: UpdateBundleName): Promise<void> {
  assertNameWithinLimit(name, "Bundle name");
  const updated = await db
    .update(bundleTable)
    .set({ name })
    .where(and(eq(bundleTable.projectId, projectId), eq(bundleTable.id, bundleId)))
    .returning({ id: bundleTable.id });
  assertFound(updated, `Bundle projectId=${projectId} bundleId=${bundleId}`);
}
