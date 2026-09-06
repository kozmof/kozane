import type { Handle } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { randomUUID } from "node:crypto";
import { getDb } from "./db/client";
import { getDBURL, getWorkspaceRoot } from "./db/internal/config";
import { getMigrationStatus } from "./db/internal/migrations";
import { readApiKeyResult } from "./lib/server/api-key";
import { claimServerState, removeServerState } from "./lib/server/runtime-state";
import {
  applySecurityHeaders,
  isAllowedRequestHost,
  remoteBindingRequiresApiKey,
  remoteBindingRequiresTls,
} from "./lib/server/security";
import { authenticateRequest } from "./lib/server/request-auth";
import { LOGIN_PATH } from "./lib/server/login";

// Default to localhost so that running `node build/index.js` directly without
// the CLI never accidentally exposes the server on all interfaces.
// The CLI (kozane open) always sets HOST explicitly, so this is a no-op there.
//
// A backstop, and no longer the mechanism. `bin/server.js` is Kozane's server entry and
// calls `listen` itself with `DEFAULT_SERVER_HOST`, so nothing about the address Kozane
// binds depends on this line, or on when it runs.
//
// It stays for the entry Kozane does not use. `build/index.js` is excluded from the
// published package now — `files` in `package.json` drops it, and
// `scripts/check-package-entry.mjs` fails the release if it comes back — but `vite build`
// still emits it, so it is there in every checkout and `pnpm build && node build/index.js`
// is a thing a contributor can do. Adapter-node's default there is `env('HOST', '0.0.0.0')`,
// and this assignment is what keeps that off every interface.
//
// It happens to win that race — `index.js` statically imports the handler chunk, that chunk
// ends in a top-level `await server.init(...)`, and `init()` reaches hooks through a dynamic
// import, so hooks evaluates before the entry's body reads HOST. That chain is two SvelteKit
// internals deep and could change in a minor release without an error, which is precisely
// why it is not what the supported path relies on any more.
//
// `scripts/smoke-production.mjs` starts a server with HOST unset and asserts the socket is
// loopback and that the machine's routable address is refused, so a regression on either
// path fails a check rather than shipping.
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
 * The schema check's answer, or null while it has not been made. Held rather than repeated:
 * a current workspace is checked once and never again, because the only thing that could
 * migrate it out from under a running server is `kozane db migrate`, which refuses to run
 * while one holds the workspace.
 *
 * A *stale* answer is re-checked on the interval {@link CONFLICT_RECHECK_MS} sets, for the
 * same reason the runtime-state conflict is: `kozane db migrate` in another terminal is the
 * ordinary way out of this state, and a latched answer would go on refusing every request
 * until the server was restarted too.
 */
let migrationBlock: { message: string; checkedAt: number } | null = null;
let migrationsVerified = false;

/**
 * Why this process may not serve the workspace's database, or null when it may.
 *
 * The gap this closes: every CLI command runs `requireCurrentMigrations` through
 * `runWorkspaceCommand`, and `kozane open` runs it before spawning anything — but the server
 * itself never did. Started any other way — `node bin/server.js` under a process manager, a
 * container that mounts a workspace an older release wrote — it opened whatever was there and
 * failed at the first query, with SQLite's wording about a missing column standing in for
 * "this workspace needs migrating".
 *
 * 503 and not 500, and answered rather than thrown, for the reason the unreadable key file
 * is: the condition belongs to the workspace rather than to the request, and it clears
 * without a restart.
 */
async function checkMigrations(): Promise<string | null> {
  if (migrationsVerified) return null;
  if (migrationBlock && Date.now() - migrationBlock.checkedAt < CONFLICT_RECHECK_MS)
    return migrationBlock.message;

  let url: string;
  try {
    url = getDBURL();
  } catch {
    // No workspace at all. Left to the database open below, which already words that case.
    return null;
  }

  // An in-memory database is migrated by the act of opening it (`openDb`), and there is no
  // file for a second connection to look at: `getMigrationStatus` would open its own empty
  // one, find no `__drizzle_migrations` table, and report every migration pending. The same
  // exemption `kozane open --memory` takes for the same reason.
  if (url.includes(":memory:")) {
    migrationsVerified = true;
    return null;
  }

  const status = await getMigrationStatus(url);
  if (status.state === "current") {
    migrationsVerified = true;
    migrationBlock = null;
    return null;
  }

  const message =
    status.state === "pending"
      ? `Kozane database is behind this version (${status.pendingCount} migration${status.pendingCount === 1 ? "" : "s"} pending). Run 'kozane db migrate'.`
      : status.state === "gapped"
        ? "Kozane database has a gapped migration history and cannot be repaired by migrating. Run 'kozane db status', then 'kozane db restore'."
        : status.state === "missing"
          ? "No Kozane workspace database found. Run 'kozane init' first."
          : `Kozane database state could not be read: ${status.error}. Run 'kozane doctor'.`;

  // Only when it is news, for the reason `registerRuntimeState` gives: re-checking on a
  // timer would otherwise write the same line every few seconds for as long as it stands.
  if (migrationBlock?.message !== message) console.error(`[kozane] ${message}`);
  migrationBlock = { message, checkedAt: Date.now() };
  return message;
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
 * 6. **Host, for a keyless workspace only.** The one mode with no key to check, so the
 *    name the request arrived under is all there is to go on; see `isAllowedRequestHost`.
 *    Skipped entirely once a key exists, where gate 8 is the real answer.
 * 7. **Login page exemption.** After 3–6 so those still apply to it, and before the key
 *    check so that redirecting an unauthenticated browser to it cannot loop.
 * 8. **The key check** (`authenticateRequest`).
 * 9. **The schema**, and 10. **the database**, both only for a request that got this far.
 *    The schema is a condition of the workspace like gates 2–5, and would sit with them but
 *    for what it costs: answering it opens the database file, so asking it before the key
 *    check would do that work for every unauthenticated prober, and would tell one the
 *    workspace's migration state. `migrationsVerified` makes the steady-state cost one check
 *    per process.
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
  // A keyless workspace has no credential to check, so the name the request arrived under
  // is the only thing separating the user's own browser from a page that pointed someone
  // else's hostname at this address. Read from the raw header rather than `event.url`,
  // which `kozane open` pins through `ORIGIN` and which would therefore always agree.
  if (!configuredKey) {
    const requestHost = event.request.headers.get("host") ?? event.url.host;
    if (!isAllowedRequestHost(requestHost)) {
      return applySecurityHeaders(
        new Response(
          `This Kozane workspace does not answer to host "${requestHost}". Reach it on localhost, run 'kozane api key generate' to allow named access, or set KOZANE_ALLOWED_HOSTS.`,
          { status: 403 },
        ),
      );
    }
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
  const behind = await checkMigrations();
  if (behind) return applySecurityHeaders(new Response(behind, { status: 503 }));

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
