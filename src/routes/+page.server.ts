import type { Actions, PageServerLoad, RequestEvent } from "./$types";
import { fail } from "@sveltejs/kit";
import { createNamespace, getAllNamespaces } from "../db/api/namespace.js";
import { getWorkspaceRoot } from "../db/internal/config.js";
import { NAME_MAX } from "$lib/constants";

// Static export (kozane net ssg generate): prerender to HTML and hide the local workspace path,
// which is a machine-specific absolute path that must not be published.
export const prerender = process.env.KOZANE_SSG === "1";
const readonly = process.env.KOZANE_READONLY === "1";

export const load: PageServerLoad = async ({ locals }) => {
  const namespaces = await getAllNamespaces({ db: locals.db });
  return {
    namespaces,
    workspaceRoot: readonly ? null : getWorkspaceRoot(),
    readonly,
  };
};

const namespaceActions = {
  default: async ({ locals, request }: RequestEvent) => {
    const form = await request.formData();
    const submitted = form.get("name");
    const name = typeof submitted === "string" ? submitted.trim() : "";

    if (!name) return fail(400, { error: "Namespace name is required." });
    if (name.length > NAME_MAX) {
      return fail(400, { error: `Namespace name must be ${NAME_MAX} characters or fewer.` });
    }

    await createNamespace({ db: locals.db, name });
    return { success: true };
  },
} satisfies Actions;

/**
 * Dropped entirely in read-only mode: the static export prerenders this page, and SvelteKit
 * refuses to prerender a page that exports actions at all — an empty object still counts.
 * The cast keeps the page's `form` type describing what the action returns, which is what a
 * non-static build always has.
 */
export const actions = (readonly ? undefined : namespaceActions) as typeof namespaceActions;
