import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getWorkspaceRoot } from "$db/internal/config";
import {
  API_KEY_COOKIE,
  apiKeyCookieOptions,
  apiKeysEqual,
  readApiKeyResult,
  type ApiKeyFile,
} from "../../lib/server/api-key.js";
import { safeNext } from "../../lib/server/login.js";
import {
  authFailureRetryAfter,
  clearAuthFailures,
  recordAuthFailure,
} from "../../lib/server/security.js";

// Keep authentication dynamic and exclude it from static prerendering.
export const prerender = false;

/**
 * The configured key, or a 503 naming what is wrong with the file.
 *
 * The request hooks normally catch key-file errors first. Keep this check so direct calls
 * also report an unreadable key file as a 503 response.
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

function tooManyAttempts(retryAfter: number): string {
  return `Too many attempts. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`;
}

export const actions: Actions = {
  default: async ({ request, url, cookies, getClientAddress }) => {
    const root = getWorkspaceRoot();
    const key = configuredKey(root);
    const next = safeNext(url.searchParams.get("next"));
    if (!key) redirect(303, next);

    // Refuse a throttled client before comparing its key. See `authenticateRequest`.
    const throttled = authFailureRetryAfter(getClientAddress());
    if (throttled) return fail(429, { error: tooManyAttempts(throttled) });

    const form = await request.formData();
    const submitted = form.get("apiKey");
    const suppliedKey = typeof submitted === "string" ? submitted : "";

    if (!apiKeysEqual(suppliedKey, key.apiKey)) {
      const retryAfter = recordAuthFailure(getClientAddress());
      if (retryAfter) {
        return fail(429, { error: tooManyAttempts(retryAfter) });
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
