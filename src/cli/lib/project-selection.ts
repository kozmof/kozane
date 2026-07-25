import type { DB } from "../../db/tx.js";
import { projectTable } from "../../db/schema.js";
import { resolveShortId } from "./short-id.js";

export async function resolveProjectId(db: DB, requestedId?: string): Promise<string> {
  const projects = await db
    .select({ id: projectTable.id, isDefault: projectTable.isDefault })
    .from(projectTable);
  if (requestedId) {
    return resolveShortId(
      requestedId,
      projects.map(({ id }) => id),
      "Project",
    );
  }
  if (projects.length === 0) {
    throw new Error('No projects found. Run "kozane project create <name>" first.');
  }
  const defaultProject = projects.find(({ isDefault }) => isDefault);
  if (defaultProject) return defaultProject.id;
  if (projects.length === 1) return projects[0].id;
  throw new Error(
    'Workspace has multiple projects but no default. Run "kozane project default <projectId>".',
  );
}
