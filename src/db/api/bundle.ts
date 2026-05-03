import { bundleTable } from "../schema.js";
import { and, eq } from "drizzle-orm";
import type { NeedsProject, Bundle } from "./types.js";
import { assertFound } from "./utils.js";

export async function getAllBundles({ db, projectId }: NeedsProject): Promise<Bundle[]> {
  return db.select().from(bundleTable).where(eq(bundleTable.projectId, projectId));
}

type GetBundle = NeedsProject & { bundleId: string };
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
export async function addBundle({ db, projectId, name, isDefault = false }: AddBundle): Promise<string> {
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

type DeleteBundle = NeedsProject & { bundleId: string };
export async function deleteBundle({ db, projectId, bundleId }: DeleteBundle): Promise<void> {
  const deleted = await db
    .delete(bundleTable)
    .where(and(eq(bundleTable.projectId, projectId), eq(bundleTable.id, bundleId)))
    .returning({ id: bundleTable.id });
  assertFound(deleted, `Bundle projectId=${projectId} bundleId=${bundleId}`);
}

type UpdateBundleName = NeedsProject & { bundleId: string; name: string };
export async function updateBundleName({
  db,
  projectId,
  bundleId,
  name,
}: UpdateBundleName): Promise<void> {
  const updated = await db
    .update(bundleTable)
    .set({ name })
    .where(and(eq(bundleTable.projectId, projectId), eq(bundleTable.id, bundleId)))
    .returning({ id: bundleTable.id });
  assertFound(updated, `Bundle projectId=${projectId} bundleId=${bundleId}`);
}
