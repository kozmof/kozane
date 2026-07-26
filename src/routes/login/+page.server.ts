import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getWorkspaceRoot } from "../../db/internal/config";
import {
  API_KEY_COOKIE,
  apiKeyCookieOptions,
  apiKeysEqual,
  readApiKey,
} from "../../lib/server/api-key";
import { safeNext } from "../../lib/server/login";
import { clearAuthFailures, recordAuthFailure } from "../../lib/server/security";

// Dynamic auth endpoint: must never be prerendered into the static export.
export const prerender = false;

export const load: PageServerLoad = async ({ url, cookies }) => {
  const root = getWorkspaceRoot();
  const configuredKey = root ? readApiKey(root) : null;
  const next = safeNext(url.searchParams.get("next"));

  // No key configured means there is nothing to authenticate against, and an
  // already-authenticated visitor has no reason to see the form.
  if (!configuredKey) redirect(303, next);
  if (apiKeysEqual(cookies.get(API_KEY_COOKIE), configuredKey.apiKey)) redirect(303, next);

  return { next };
};

export const actions: Actions = {
  default: async ({ request, url, cookies, getClientAddress }) => {
    const root = getWorkspaceRoot();
    const configuredKey = root ? readApiKey(root) : null;
    const next = safeNext(url.searchParams.get("next"));
    if (!configuredKey) redirect(303, next);

    const form = await request.formData();
    const submitted = form.get("apiKey");
    const suppliedKey = typeof submitted === "string" ? submitted : "";

    if (!apiKeysEqual(suppliedKey, configuredKey.apiKey)) {
      const retryAfter = recordAuthFailure(getClientAddress());
      if (retryAfter) {
        return fail(429, {
          error: `Too many attempts. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
        });
      }
      return fail(401, { error: "Invalid API key." });
    }

    clearAuthFailures(getClientAddress());
    cookies.set(API_KEY_COOKIE, configuredKey.apiKey, {
      ...apiKeyCookieOptions(url.protocol === "https:"),
    });
    redirect(303, next);
  },
};
