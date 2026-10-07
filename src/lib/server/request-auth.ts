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

/** Authentication decision to continue processing or return a response immediately. */
export type AuthOutcome = { kind: "pass" } | { kind: "respond"; response: Response };

const PASS: AuthOutcome = { kind: "pass" };

/**
 * Authenticate a request after workspace configuration checks. Reject throttled clients with
 * 429 before considering login redirects. Redirect browser navigation to login and return 401
 * for other unauthenticated requests.
 *
 * The caller applies security headers to the resulting response.
 */
export function authenticateRequest(event: RequestEvent, configuredKey: ApiKeyFile): AuthOutcome {
  const queryKey = event.url.searchParams.get("api_key") ?? undefined;
  const queryKeyValid = queryKey !== undefined && apiKeysEqual(queryKey, configuredKey.apiKey);
  // Accept a valid cookie or header even when the query key is wrong. A bookmarked, expired
  // key must not lock out a signed-in browser or consume its rate limit.
  const authenticated =
    queryKeyValid ||
    apiKeysEqual(
      requestApiKey(event.request, event.cookies.get(API_KEY_COOKIE)),
      configuredKey.apiKey,
    );

  if (!authenticated) {
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

  // For GET requests, exchange a valid query key for a cookie and redirect to the URL without
  // the key. Do not redirect other methods because a 303 would discard their body.
  //
  // Remove a stale query key from an otherwise authenticated GET without setting a cookie for
  // it.
  if (queryKey !== undefined && event.request.method === "GET") {
    const headers: Record<string, string> = {};
    if (queryKeyValid) {
      headers["set-cookie"] = event.cookies.serialize(
        API_KEY_COOKIE,
        configuredKey.apiKey,
        apiKeyCookieOptions(event.url.protocol === "https:"),
      );
    }
    const cleanUrl = new URL(event.url);
    cleanUrl.searchParams.delete("api_key");
    headers.location = cleanUrl.pathname + cleanUrl.search;
    return { kind: "respond", response: new Response(null, { status: 303, headers }) };
  }

  return PASS;
}
