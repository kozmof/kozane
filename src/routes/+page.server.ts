import type { Actions, PageServerLoad, RequestEvent } from "./$types";
import { fail } from "@sveltejs/kit";
import { createNamespace, getAllNamespaces } from "../db/api/namespace.js";
import { getWorkspaceRoot } from "../db/internal/config.js";
import { NAME_MAX } from "$lib/constants";
import { isSsgBuild } from "$lib/server/ssg";

// Prerender static exports and omit the machine-specific workspace path from published data.
export const prerender = isSsgBuild();
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
 * Omit actions entirely during static prerendering because even an empty actions object
 * prevents prerendering. Preserve the live action's form type through the cast.
 */
export const actions = (readonly ? undefined : namespaceActions) as typeof namespaceActions;
