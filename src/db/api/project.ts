import { projectTable } from "../schema";
import { eq } from "drizzle-orm";
import type { NeedsDB, Project } from "./types";
import { assertFound } from "./utils";

export async function getAllProjects({ db }: NeedsDB): Promise<Project[]> {
  return db.select().from(projectTable);
}

type GetProject = NeedsDB & { projectId: string };
export async function getProject({ db, projectId }: GetProject): Promise<Project | undefined> {
  return db.select().from(projectTable).where(eq(projectTable.id, projectId)).get();
}

type AddProject = NeedsDB & { name: string };
export async function addProject({ db, name }: AddProject): Promise<string> {
  const [row] = await db.insert(projectTable).values({ name }).returning({ id: projectTable.id });
  return row.id;
}

type DeleteProject = NeedsDB & { projectId: string };
export async function deleteProject({ db, projectId }: DeleteProject): Promise<void> {
  const deleted = await db
    .delete(projectTable)
    .where(eq(projectTable.id, projectId))
    .returning({ id: projectTable.id });
  assertFound(deleted, `Project projectId=${projectId}`);
}

type UpdateProjectName = NeedsDB & { projectId: string; name: string };
export async function updateProjectName({ db, projectId, name }: UpdateProjectName): Promise<void> {
  const updated = await db
    .update(projectTable)
    .set({ name })
    .where(eq(projectTable.id, projectId))
    .returning({ id: projectTable.id });
  assertFound(updated, `Project projectId=${projectId}`);
}
