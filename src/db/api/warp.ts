import { warpTable } from "../schema.js";
import { and, asc, eq } from "drizzle-orm";
import type { NeedsProject, NeedsProjectWarp, Warp } from "./types.js";
import { assertFound } from "./utils.js";

/**
 * Ordered the way the UI numbers them: oldest first. Warps carry no name and no position
 * column, so creation order is the only ordering there is, and uuidv7 ids already hold it.
 */
export async function getAllWarps({ db, projectId }: NeedsProject): Promise<Warp[]> {
  return db
    .select()
    .from(warpTable)
    .where(eq(warpTable.projectId, projectId))
    .orderBy(asc(warpTable.id));
}

type AddWarp = NeedsProject & { posX: number; posY: number };

export async function addWarp({ db, projectId, posX, posY }: AddWarp): Promise<Warp> {
  const [row] = await db.insert(warpTable).values({ projectId, posX, posY }).returning();
  return row;
}

type DeleteWarp = NeedsProjectWarp;

export async function deleteWarp({ db, projectId, warpId }: DeleteWarp): Promise<void> {
  // projectId is redundant for the lookup (warpId is a UUID) but is checked as a
  // defence-in-depth access boundary, the same way deleteLayer does it.
  const deleted = await db
    .delete(warpTable)
    .where(and(eq(warpTable.projectId, projectId), eq(warpTable.id, warpId)))
    .returning({ id: warpTable.id });
  assertFound(deleted, `Warp projectId=${projectId} warpId=${warpId}`);
}
