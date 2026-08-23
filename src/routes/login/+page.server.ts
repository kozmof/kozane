import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getWorkspaceRoot } from "../../db/internal/config";
import {
  API_KEY_COOKIE,
  apiKeyCookieOptions,
  apiKeysEqual,
  readApiKeyResult,
  type ApiKeyFile,
} from "../../lib/server/api-key";
import { safeNext } from "../../lib/server/login";
import { clearAuthFailures, recordAuthFailure } from "../../lib/server/security";

// Dynamic auth endpoint: must never be prerendered into the static export.
export const prerender = false;

/**
 * The configured key, or a 503 naming what is wrong with the file.
 *
 * `hooks.server.ts` reads the key before this page is reached and answers the same 503, so
 * in a served workspace the check here never fires. It is here anyway because the
 * alternative is a bare `throw` from the load function of the one page whose whole job is
 * to be reachable when authentication is not working.
 */
function configuredKey(root: string | null): ApiKeyFile | null {
  if (!root) return null;
  const result = readApiKeyResult(root);
  if (!result.ok)
    error(503, `${result.message}. Fix the file, or run 'kozane api key refresh' to replace it.`);
  return result.key;
}

export const load: PageServerLoad = async ({ url, cookies }) => {
  const root = getWorkspaceRoot();
  const key = configuredKey(root);
  const next = safeNext(url.searchParams.get("next"));

  // No key configured means there is nothing to authenticate against, and an
  // already-authenticated visitor has no reason to see the form.
  if (!key) redirect(303, next);
  if (apiKeysEqual(cookies.get(API_KEY_COOKIE), key.apiKey)) redirect(303, next);

  return { next };
};

export const actions: Actions = {
  default: async ({ request, url, cookies, getClientAddress }) => {
    const root = getWorkspaceRoot();
    const key = configuredKey(root);
    const next = safeNext(url.searchParams.get("next"));
    if (!key) redirect(303, next);

    const form = await request.formData();
    const submitted = form.get("apiKey");
    const suppliedKey = typeof submitted === "string" ? submitted : "";

    if (!apiKeysEqual(suppliedKey, key.apiKey)) {
      const retryAfter = recordAuthFailure(getClientAddress());
      if (retryAfter) {
        return fail(429, {
          error: `Too many attempts. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
        });
      }
      return fail(401, { error: "Invalid API key." });
    }

    clearAuthFailures(getClientAddress());
    cookies.set(API_KEY_COOKIE, key.apiKey, {
      ...apiKeyCookieOptions(url.protocol === "https:"),
    });
    redirect(303, next);
  },
};
