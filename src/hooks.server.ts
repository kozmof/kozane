import type { Handle } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { randomUUID } from "node:crypto";
import { getDb } from "./db/client";
import { getWorkspaceRoot } from "./db/internal/config";
import {
  API_KEY_COOKIE,
  apiKeyCookieOptions,
  apiKeysEqual,
  readApiKey,
  requestApiKey,
} from "./lib/server/api-key";
import { claimServerState, removeServerState } from "./lib/server/runtime-state";
import {
  applySecurityHeaders,
  clearAuthFailures,
  isBrowserNavigation,
  recordAuthFailure,
  remoteBindingRequiresApiKey,
  remoteBindingRequiresTls,
} from "./lib/server/security";
import { LOGIN_PATH } from "./lib/server/login";

// Default to localhost so that running `node build/index.js` directly without
// the CLI never accidentally exposes the server on all interfaces.
// The CLI (kozane open) always sets HOST explicitly, so this is a no-op there.
process.env.HOST ??= "127.0.0.1";

let registeredRoot: string | null = null;
/**
 * Set once the workspace turns out to belong to another server. Remembered rather than
 * rediscovered: without it every request races for the same lock file and answers with a
 * fresh 500, which reads as an intermittent fault rather than the one permanent condition
 * it is. The reservation is not attempted at module load, where a plain `vite build` that
 * happens to run inside a workspace would claim it.
 */
let runtimeStateConflict: string | null = null;

/** The reason this process may not serve `root`, or null when it may. */
function registerRuntimeState(root: string | null): string | null {
  if (runtimeStateConflict) return runtimeStateConflict;
  if (!root || registeredRoot === root) return null;
  const active = claimServerState(root, process.pid, {
    memory: process.env.KOZANE_MEMORY_MODE === "1",
    databaseUrl: process.env.KOZANE_RUNTIME_DATABASE_URL,
  });
  if (active) {
    runtimeStateConflict = `Kozane workspace is already served by process ${active.pid}. Stop that server, or run this one against another workspace.`;
    console.error(`[kozane] ${runtimeStateConflict}`);
    return runtimeStateConflict;
  }
  registeredRoot = root;
  process.once("exit", () => removeServerState(root));
  return null;
}

const handleRequest: Handle = async ({ event, resolve }) => {
  const root = getWorkspaceRoot();

  // Static export build (kozane net ssg generate): prerendering issues synthetic requests
  // against the local workspace DB. Skip the API-key/TLS gating entirely — the
  // export is inherently public and read-only, and enforcing auth here would make
  // prerendering fail with 401s on any workspace that has an API key configured.
  if (process.env.KOZANE_SSG === "1") {
    event.locals.db = await getDb();
    return resolve(event);
  }

  const conflict = registerRuntimeState(root);
  if (conflict) return applySecurityHeaders(new Response(conflict, { status: 503 }));

  const configuredKey = root ? readApiKey(root) : null;
  if (!configuredKey && remoteBindingRequiresApiKey()) {
    return applySecurityHeaders(
      new Response("Remote binding requires a Kozane API key. Run 'kozane api key generate'.", {
        status: 503,
      }),
    );
  }
  if (remoteBindingRequiresTls(event.url.protocol)) {
    return applySecurityHeaders(
      new Response(
        "Remote access requires HTTPS. Configure a TLS reverse proxy and trusted protocol headers.",
        { status: 426, headers: { upgrade: "TLS/1.2" } },
      ),
    );
  }
  // The login page must render and accept its form POST without a valid key,
  // otherwise redirecting unauthenticated browsers to it would loop. It runs
  // after the no-key (503) and TLS (426) gates above so those still apply.
  if (configuredKey && event.url.pathname === LOGIN_PATH) {
    return applySecurityHeaders(await resolve(event));
  }
  if (configuredKey) {
    const queryKey = event.url.searchParams.get("api_key") ?? undefined;
    const suppliedKey = queryKey ?? requestApiKey(event.request, event.cookies.get(API_KEY_COOKIE));
    if (!apiKeysEqual(suppliedKey, configuredKey.apiKey)) {
      const client = event.getClientAddress();
      const retryAfter = recordAuthFailure(client);
      // A rate-limited request is never redirected into the login page — that
      // would let a brute-force loop bypass the limiter — so 429 wins for every
      // client type. Otherwise send browser navigations to the login page and
      // keep the machine-readable 401 for API/fetch clients.
      if (retryAfter) {
        return applySecurityHeaders(
          new Response("Too Many Requests", {
            status: 429,
            headers: { "retry-after": String(retryAfter) },
          }),
        );
      }
      if (isBrowserNavigation(event.request)) {
        const next = event.url.pathname + event.url.search;
        return applySecurityHeaders(
          new Response(null, {
            status: 303,
            headers: { location: `${LOGIN_PATH}?next=${encodeURIComponent(next)}` },
          }),
        );
      }
      return applySecurityHeaders(
        new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="Kozane"' },
        }),
      );
    }
    clearAuthFailures(event.getClientAddress());
    if (queryKey) {
      const cookie = event.cookies.serialize(
        API_KEY_COOKIE,
        configuredKey.apiKey,
        apiKeyCookieOptions(event.url.protocol === "https:"),
      );
      const cleanUrl = new URL(event.url);
      cleanUrl.searchParams.delete("api_key");
      return applySecurityHeaders(
        new Response(null, {
          status: 303,
          headers: {
            location: cleanUrl.pathname + cleanUrl.search,
            "set-cookie": cookie,
          },
        }),
      );
    }
  }
  try {
    event.locals.db = await getDb();
  } catch (e) {
    console.error("[kozane] Failed to open database:", e);
    throw error(503, "No Kozane workspace found. Run 'kozane init' first.");
  }
  return applySecurityHeaders(await resolve(event));
};

export const handle: Handle = async ({ event, resolve }) => {
  const requestId = randomUUID();
  const startedAt = performance.now();
  event.locals.requestId = requestId;

  try {
    const response = await handleRequest({ event, resolve });
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    if (process.env.KOZANE_LOG_REQUESTS === "1") {
      console.log(
        JSON.stringify({
          level: "info",
          event: "http_request",
          requestId,
          method: event.request.method,
          path: event.url.pathname,
          status: response.status,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        }),
      );
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (requestError) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "http_request_error",
        requestId,
        method: event.request.method,
        path: event.url.pathname,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error: requestError instanceof Error ? requestError.message : String(requestError),
      }),
    );
    throw requestError;
  }
};
