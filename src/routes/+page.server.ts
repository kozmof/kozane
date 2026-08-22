import type { Actions, PageServerLoad, RequestEvent } from "./$types";
import { fail } from "@sveltejs/kit";
import { createProject, getAllProjects } from "../db/api/project";
import { getWorkspaceRoot } from "../db/internal/config";
import { NAME_MAX } from "$lib/constants";

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

const projectActions = {
  default: async ({ locals, request }: RequestEvent) => {
    const form = await request.formData();
    const submitted = form.get("name");
    const name = typeof submitted === "string" ? submitted.trim() : "";

    if (!name) return fail(400, { error: "Project name is required." });
    if (name.length > NAME_MAX) {
      return fail(400, { error: `Project name must be ${NAME_MAX} characters or fewer.` });
    }

    await createProject({ db: locals.db, name });
    return { success: true };
  },
} satisfies Actions;

/**
 * Dropped entirely in read-only mode: the static export prerenders this page, and SvelteKit
 * refuses to prerender a page that exports actions at all — an empty object still counts.
 * The cast keeps the page's `form` type describing what the action returns, which is what a
 * non-static build always has.
 */
export const actions = (readonly ? undefined : projectActions) as typeof projectActions;
