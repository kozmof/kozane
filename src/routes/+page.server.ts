import type { PageServerLoad } from "./$types";
import { getAllProjects } from "../db/api/project";
import { getWorkspaceRoot } from "../db/internal/config";

export const load: PageServerLoad = async ({ locals }) => {
  const projects = await getAllProjects({ db: locals.db });
  return { projects, workspaceRoot: getWorkspaceRoot() };
};
