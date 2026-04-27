import type { PageServerLoad } from "./$types";
import { getAllProjects } from "../db/api/project";

export const load: PageServerLoad = async ({ locals }) => {
  const projects = await getAllProjects({ db: locals.db });
  return { projects };
};
