import type { Actions, PageServerLoad, RequestEvent } from "./$types";
import { fail } from "@sveltejs/kit";
import * as namespacesService from "../services/namespaces.js";
import { ValidationError } from "../services/errors.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { getWorkspaceName, getWorkspaceRoot } from "../db/internal/config.js";
import { NAME_MAX } from "$lib/constants";
import { isSsgBuild } from "$lib/server/ssg";

// Prerender static exports and omit the machine-specific workspace path from published data.
export const prerender = isSsgBuild();
const readonly = process.env.KOZANE_READONLY === "1";

export const load: PageServerLoad = async ({ locals }) => {
  const namespaces = await namespacesService.list(locals.db, workspaceServiceContext());
  return {
    namespaces,
    workspaceRoot: readonly ? null : getWorkspaceRoot(),
    workspaceName: getWorkspaceName(),
    readonly,
  };
};

const namespaceActions = {
  default: async ({ locals, request }: RequestEvent) => {
    const form = await request.formData();
    const submitted = form.get("name");
    const name = typeof submitted === "string" ? submitted.trim() : "";

    try {
      await namespacesService.create(locals.db, workspaceServiceContext(), { name });
    } catch (error) {
      if (error instanceof ValidationError) {
        const compatible: Record<string, string> = {
          "name is required": "Namespace name is required.",
          [`name must be ${NAME_MAX} characters or fewer`]: `Namespace name must be ${NAME_MAX} characters or fewer.`,
        };
        return fail(400, { error: compatible[error.message] ?? error.message });
      }
      throw error;
    }
    return { success: true };
  },
} satisfies Actions;

/**
 * Omit actions entirely during static prerendering because even an empty actions object
 * prevents prerendering. Preserve the live action's form type through the cast.
 */
export const actions = (readonly ? undefined : namespaceActions) as typeof namespaceActions;
