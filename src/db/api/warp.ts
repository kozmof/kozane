import { warpTable } from "../schema.js";
import { and, asc, eq } from "drizzle-orm";
import type { NeedsDB, NeedsNamespace, NeedsNamespaceWarp, Warp } from "./types.js";
import { assertFound } from "./utils.js";

/**
 * Ordered the way the UI numbers them: oldest first. Warps carry no name and no position
 * column, so creation order is the only ordering there is, and uuidv7 ids already hold it.
 */
export async function getAllWarps({ db, namespaceId }: NeedsNamespace): Promise<Warp[]> {
  return db
    .select()
    .from(warpTable)
    .where(eq(warpTable.namespaceId, namespaceId))
    .orderBy(asc(warpTable.id));
}

/**
 * Every warp in the workspace, for the cross-namespace warp palette. Ordered by namespace and
 * then by id, so the warps of one namespace arrive in the same creation order
 * {@link getAllWarps} gives them and keep the numbers their markers show.
 */
export async function getAllWorkspaceWarps({ db }: NeedsDB): Promise<Warp[]> {
  return db.select().from(warpTable).orderBy(asc(warpTable.namespaceId), asc(warpTable.id));
}

type AddWarp = NeedsNamespace & { posX: number; posY: number };

export async function addWarp({ db, namespaceId, posX, posY }: AddWarp): Promise<Warp> {
  const [row] = await db.insert(warpTable).values({ namespaceId, posX, posY }).returning();
  return row;
}

type MoveWarp = NeedsNamespaceWarp & { posX: number; posY: number };

/**
 * Puts a warp somewhere else on the board. The whole stored row comes back, so a caller
 * that drew the marker where the pointer let go can correct it to what was kept.
 */
export async function moveWarp({ db, namespaceId, warpId, posX, posY }: MoveWarp): Promise<Warp> {
  // namespaceId is checked alongside the id for the reason deleteWarp checks it: the id
  // alone would do, and the pair is the access boundary.
  const updated = await db
    .update(warpTable)
    .set({ posX, posY })
    .where(and(eq(warpTable.namespaceId, namespaceId), eq(warpTable.id, warpId)))
    .returning();
  assertFound(updated, `Warp namespaceId=${namespaceId} warpId=${warpId}`);
  return updated[0];
}

type DeleteWarp = NeedsNamespaceWarp;

export async function deleteWarp({ db, namespaceId, warpId }: DeleteWarp): Promise<void> {
  // namespaceId is redundant for the lookup (warpId is a UUID) but is checked as a
  // defence-in-depth access boundary, the same way deleteLayer does it.
  const deleted = await db
    .delete(warpTable)
    .where(and(eq(warpTable.namespaceId, namespaceId), eq(warpTable.id, warpId)))
    .returning({ id: warpTable.id });
  assertFound(deleted, `Warp namespaceId=${namespaceId} warpId=${warpId}`);
}
