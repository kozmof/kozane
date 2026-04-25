import { bundleTable } from "../schema";
import { and, eq } from "drizzle-orm";
import type { WithProject, Bundle } from "./types";
import { assertFound } from "./utils";

type BundleBase = WithProject;

export async function listBundles({ db, projectId }: BundleBase): Promise<Bundle[]> {
  return db.select().from(bundleTable).where(eq(bundleTable.projectId, projectId));
}

type GetBundle = BundleBase & { bundleId: string };
export async function getBundle({ db, projectId, bundleId }: GetBundle): Promise<Bundle | undefined> {
  // bundleId alone would uniquely identify the row (UUID), but projectId is checked too as a
  // defence-in-depth access boundary so callers cannot reach across project lines via a bare ID.
  return db
    .select()
    .from(bundleTable)
    .where(and(eq(bundleTable.projectId, projectId), eq(bundleTable.id, bundleId)))
    .get();
}

type AddBundle = BundleBase & { name: string };
export async function addBundle({ db, projectId, name }: AddBundle): Promise<string> {
  const [row] = await db
    .insert(bundleTable)
    .values({ projectId, name })
    .returning({ id: bundleTable.id });
  return row.id;
}

type DeleteBundle = BundleBase & { bundleId: string };
export async function deleteBundle({ db, projectId, bundleId }: DeleteBundle): Promise<void> {
  const deleted = await db
    .delete(bundleTable)
    .where(and(eq(bundleTable.projectId, projectId), eq(bundleTable.id, bundleId)))
    .returning({ id: bundleTable.id });
  assertFound(deleted, `Bundle projectId=${projectId} bundleId=${bundleId}`);
}

type UpdateBundleName = BundleBase & { bundleId: string; name: string };
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
