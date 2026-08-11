import { projectTable } from "../schema.js";
import { eq } from "drizzle-orm";
import type { NeedsDB, Project } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";
import { withTx, type DB } from "../tx.js";

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

type DeleteProject = { db: DB; projectId: string };
export async function deleteProject({ db, projectId }: DeleteProject): Promise<void> {
  await withTx(db, async (tx) => {
    const project = await tx
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .get();
    assertFound(project ? [project] : [], `Project projectId=${projectId}`);
    await tx.delete(projectTable).where(eq(projectTable.id, projectId));

    if (project?.isDefault) {
      const replacement = await tx
        .select({ id: projectTable.id })
        .from(projectTable)
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
