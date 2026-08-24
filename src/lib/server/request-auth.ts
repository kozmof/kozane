import type { RequestEvent } from "@sveltejs/kit";
import {
  API_KEY_COOKIE,
  apiKeyCookieOptions,
  apiKeysEqual,
  requestApiKey,
  type ApiKeyFile,
} from "./api-key.js";
import { clearAuthFailures, isBrowserNavigation, recordAuthFailure } from "./security.js";
import { LOGIN_PATH } from "./login.js";

/**
 * What the key check decided: either the request may go on to be served, or here is the
 * response to send instead. `pass` carries nothing — a request that authenticated is an
 * ordinary request from here on.
 */
export type AuthOutcome = { kind: "pass" } | { kind: "respond"; response: Response };

const PASS: AuthOutcome = { kind: "pass" };

/**
 * Whether a request carries the workspace's API key, and what to answer when it does not.
 *
 * Lifted out of `hooks.server.ts`, where it was the long tail of a gate chain that also
 * decides three unrelated things — whether another server holds the workspace, whether the
 * key file can be read at all, and whether the binding demands TLS. Those are conditions of
 * the workspace; this is a property of one request, and it is the only part of the chain
 * with branches worth reaching directly from a test rather than through a whole hook.
 *
 * The order inside is load-bearing and unchanged:
 *
 * 1. A rate-limited client gets 429 whatever kind of client it is. Redirecting it to the
 *    login page instead would let a brute-force loop bypass the limiter.
 * 2. A browser navigation goes to the login page, so a person who opens the workspace on
 *    another device is asked for the key rather than shown a bare 401.
 * 3. Everything else — API and `fetch` clients — gets the machine-readable 401.
 *
 * The caller is responsible for the gates that run *before* this one, and for
 * `applySecurityHeaders` on whatever comes back.
 */
export function authenticateRequest(event: RequestEvent, configuredKey: ApiKeyFile): AuthOutcome {
  const queryKey = event.url.searchParams.get("api_key") ?? undefined;
  const suppliedKey = queryKey ?? requestApiKey(event.request, event.cookies.get(API_KEY_COOKIE));

  if (!apiKeysEqual(suppliedKey, configuredKey.apiKey)) {
    const retryAfter = recordAuthFailure(event.getClientAddress());
    if (retryAfter) {
      return {
        kind: "respond",
        response: new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": String(retryAfter) },
        }),
      };
    }
    if (isBrowserNavigation(event.request)) {
      const next = event.url.pathname + event.url.search;
      return {
        kind: "respond",
        response: new Response(null, {
          status: 303,
          headers: { location: `${LOGIN_PATH}?next=${encodeURIComponent(next)}` },
        }),
      };
    }
    return {
      kind: "respond",
      response: new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="Kozane"' },
      }),
    };
  }

  clearAuthFailures(event.getClientAddress());

  // The key arrived in the URL, which is how `kozane open` hands it to the browser once.
  // Exchanged for the cookie and redirected to the same page without it, so the key stops
  // being in the address bar, in history, and in any referer the page goes on to send.
  if (queryKey) {
    const cookie = event.cookies.serialize(
      API_KEY_COOKIE,
      configuredKey.apiKey,
      apiKeyCookieOptions(event.url.protocol === "https:"),
    );
    const cleanUrl = new URL(event.url);
    cleanUrl.searchParams.delete("api_key");
    return {
      kind: "respond",
      response: new Response(null, {
        status: 303,
        headers: { location: cleanUrl.pathname + cleanUrl.search, "set-cookie": cookie },
      }),
    };
  }

  return PASS;
}
