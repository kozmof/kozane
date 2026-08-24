import type { Handle } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { randomUUID } from "node:crypto";
import { getDb } from "./db/client";
import { getWorkspaceRoot } from "./db/internal/config";
import { readApiKeyResult } from "./lib/server/api-key";
import { claimServerState, removeServerState } from "./lib/server/runtime-state";
import {
  applySecurityHeaders,
  remoteBindingRequiresApiKey,
  remoteBindingRequiresTls,
} from "./lib/server/security";
import { authenticateRequest } from "./lib/server/request-auth";
import { LOGIN_PATH } from "./lib/server/login";

// Default to localhost so that running `node build/index.js` directly without
// the CLI never accidentally exposes the server on all interfaces.
// The CLI (kozane open) always sets HOST explicitly, so this is a no-op there.
process.env.HOST ??= "127.0.0.1";

let registeredRoot: string | null = null;
/**
 * Set once the workspace turns out to belong to another server. Remembered rather than
 * rediscovered per request: without it every request races for the same lock file and
 * answers with a fresh 500, which reads as an intermittent fault rather than the one
 * condition it is. The reservation is not attempted at module load, where a plain `vite
 * build` that happens to run inside a workspace would claim it.
 */
let runtimeStateConflict: string | null = null;
let conflictCheckedAt = 0;
/**
 * How long a conflict is trusted before the reservation is tried again. The conflict used
 * to be latched for the lifetime of the process, which made "the other server has since
 * stopped" indistinguishable from "it is still running": every request went on failing
 * until this one was restarted too. Long enough that a browser reloading against a
 * genuinely occupied workspace does not go back to racing for the lock file.
 */
const CONFLICT_RECHECK_MS = 5_000;

/** The reason this process may not serve `root`, or null when it may. */
function registerRuntimeState(root: string | null): string | null {
  if (!root || registeredRoot === root) return null;
  if (runtimeStateConflict && Date.now() - conflictCheckedAt < CONFLICT_RECHECK_MS)
    return runtimeStateConflict;

  const active = claimServerState(root, process.pid, {
    memory: process.env.KOZANE_MEMORY_MODE === "1",
    databaseUrl: process.env.KOZANE_RUNTIME_DATABASE_URL,
  });
  if (active) {
    const message = `Kozane workspace is already served by process ${active.pid}. Stop that server, or run this one against another workspace.`;
    // Only when it is news: re-checking on a timer would otherwise write the same line to
    // the log every few seconds for as long as the other server runs.
    if (runtimeStateConflict !== message) console.error(`[kozane] ${message}`);
    runtimeStateConflict = message;
    conflictCheckedAt = Date.now();
    return runtimeStateConflict;
  }
  runtimeStateConflict = null;
  registeredRoot = root;
  process.once("exit", () => removeServerState(root));
  return null;
}

/**
 * The gates every request passes, in the order they run. The order is load-bearing, so it
 * is written down rather than left to be inferred from the sequence below:
 *
 * 1. **SSG bypass.** A prerender pass is not a request from anyone and skips the rest.
 * 2. **Runtime state.** Another server holding this workspace is a condition of the
 *    workspace, not of the request, so it answers before anything about the request is read.
 * 3. **Key file readable.** Likewise the workspace's, and answered rather than thrown: see
 *    `readApiKeyResult`.
 * 4. **Remote binding has a key**, and 5. **remote binding is over TLS.** Both refuse a
 *    misconfigured *server*, so they run before any question of who is asking — a
 *    workspace bound to the world without a key must not answer a login page either.
 * 6. **Login page exemption.** After 3–5 so those still apply to it, and before the key
 *    check so that redirecting an unauthenticated browser to it cannot loop.
 * 7. **The key check** (`authenticateRequest`).
 * 8. **The database**, opened only for a request that got this far.
 */
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

  const key = root ? readApiKeyResult(root) : ({ ok: true, key: null } as const);
  if (!key.ok) {
    // Answered rather than thrown, the way the database below is. The key file is consulted
    // on every request, so an unreadable one is not a fault of the request being served:
    // left to throw, a hand-edited `api.json` turns every page load and every poll into a
    // 500 that says nothing about the file behind it. 503 rather than 500 because the
    // condition is the workspace's, not this request's, and it clears without a restart —
    // `readApiKey` re-reads a malformed file every time, so fixing it takes effect at once.
    return applySecurityHeaders(
      new Response(`${key.message}. Fix the file, or run 'kozane api key refresh' to replace it.`, {
        status: 503,
      }),
    );
  }
  const configuredKey = key.key;
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
    const auth = authenticateRequest(event, configuredKey);
    if (auth.kind === "respond") return applySecurityHeaders(auth.response);
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
