import { bundleTable, cardTable, glueRelTable, projectTable } from "../schema.js";
import { and, asc, eq } from "drizzle-orm";
import type { NeedsDB, Project } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";
import { withTx, type DB, type Tx } from "../tx.js";
// Safe to import here, unlike from card.ts (see the note above `deleteProjectCards`):
// glue.ts reaches into card.ts, and card.ts does not reach back into this module.
import { dissolveOrphanGlueGroupsInTx } from "./glue.js";

export async function getAllProjects({ db }: NeedsDB): Promise<Project[]> {
  return db.select().from(projectTable);
}

type GetProject = NeedsDB & { projectId: string };
export async function getProject({ db, projectId }: GetProject): Promise<Project | undefined> {
  return db.select().from(projectTable).where(eq(projectTable.id, projectId)).get();
}

type AddProject = NeedsDB & { name: string; isDefault?: boolean };
export async function addProject({ db, name, isDefault = false }: AddProject): Promise<string> {
  assertNameWithinLimit(name, "Project name");
  const [row] = await db
    .insert(projectTable)
    .values({ name, isDefault })
    .returning({ id: projectTable.id });
  return row.id;
}

export async function setDefaultProject({
  db,
  projectId,
}: {
  db: DB;
  projectId: string;
}): Promise<void> {
  await withTx(db, async (tx) => {
    await tx.update(projectTable).set({ isDefault: false }).where(eq(projectTable.isDefault, true));
    const updated = await tx
      .update(projectTable)
      .set({ isDefault: true })
      .where(eq(projectTable.id, projectId))
      .returning({ id: projectTable.id });
    assertFound(updated, `Project projectId=${projectId}`);
  });
}

/** The glue groups this project's cards belong to, read before the cascade removes them. */
async function projectGlueIds(tx: Tx, projectId: string): Promise<string[]> {
  const rows = await tx
    .select({ glueId: glueRelTable.glueId })
    .from(glueRelTable)
    .innerJoin(cardTable, eq(glueRelTable.cardId, cardTable.id))
    .innerJoin(
      bundleTable,
      and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
    );
  return rows.map((row) => row.glueId);
}

type DeleteProject = { db: DB; projectId: string };
export async function deleteProject({ db, projectId }: DeleteProject): Promise<void> {
  await withTx(db, async (tx) => {
    const project = await tx
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .get();
    assertFound(project ? [project] : [], `Project projectId=${projectId}`);

    // Read while the cards still exist: deleting the project cascades bundles, cards, and
    // their glue_rel rows away, and a `glue` row is referenced by nothing, so afterwards
    // there is no way left to tell which groups the project emptied out.
    const glueIds = await projectGlueIds(tx, projectId);
    await tx.delete(projectTable).where(eq(projectTable.id, projectId));
    // Groups the project did not empty entirely are left alone by the sweep, so a group
    // that somehow spans two projects keeps the members it still has.
    await dissolveOrphanGlueGroupsInTx(tx, glueIds);

    if (project?.isDefault) {
      // Ordered so the workspace promotes the same project twice running. uuidv7 ids sort
      // by creation, which makes this the oldest surviving project.
      const replacement = await tx
        .select({ id: projectTable.id })
        .from(projectTable)
        .orderBy(asc(projectTable.id))
        .limit(1)
        .get();
      if (replacement) {
        await tx
          .update(projectTable)
          .set({ isDefault: true })
          .where(eq(projectTable.id, replacement.id));
      }
    }
  });
}

type UpdateProjectName = NeedsDB & { projectId: string; name: string };
export async function updateProjectName({ db, projectId, name }: UpdateProjectName): Promise<void> {
  assertNameWithinLimit(name, "Project name");
  const updated = await db
    .update(projectTable)
    .set({ name })
    .where(eq(projectTable.id, projectId))
    .returning({ id: projectTable.id });
  assertFound(updated, `Project projectId=${projectId}`);
}
