import type { PageServerLoad } from "./$types";
import { listProjects } from "../db/api/project";

export const load: PageServerLoad = async ({ locals }) => {
  const projects = await listProjects({ db: locals.db });
  return { projects };
};
