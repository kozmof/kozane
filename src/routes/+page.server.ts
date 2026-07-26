import type { PageServerLoad } from "./$types";
import { getAllProjects } from "../db/api/project";
import { getWorkspaceRoot } from "../db/internal/config";

// Static export (kozane net ssg generate): prerender to HTML and hide the local workspace path,
// which is a machine-specific absolute path that must not be published.
export const prerender = process.env.KOZANE_SSG === "1";
const readonly = process.env.KOZANE_READONLY === "1";

export const load: PageServerLoad = async ({ locals }) => {
  const projects = await getAllProjects({ db: locals.db });
  return {
    projects,
    workspaceRoot: readonly ? null : getWorkspaceRoot(),
    readonly,
  };
};
