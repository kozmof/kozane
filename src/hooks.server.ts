import type { Handle } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { randomUUID } from "node:crypto";
import { getDb } from "./db/client";
import { getDBURL, getWorkspaceRoot } from "./db/internal/config";
import { isMemoryDbUrl } from "./lib/db-url";
import { isSsgBuild } from "./lib/server/ssg";
import { getMigrationStatus } from "./db/internal/migrations";
import { readApiKeyResult } from "./lib/server/api-key";
import { claimServerState, removeServerState } from "./lib/server/runtime-state";
import {
  applySecurityHeaders,
  isAllowedRequestHost,
  remoteBindingRequiresApiKey,
  remoteBindingRequiresTls,
  remoteThrottleWarning,
} from "./lib/server/security";
import { authenticateRequest } from "./lib/server/request-auth";
import { LOGIN_PATH } from "./lib/server/login";

// Set a loopback fallback for direct use of adapter-node's generated entry. This depends on
// hooks loading before that entry reads HOST.
//
// The supported `bin/server.js` entry binds to `DEFAULT_SERVER_HOST` explicitly and does not
// depend on this import order. The generated `build/index.js` is excluded from the published
// package but remains in local builds.
process.env.HOST ??= "127.0.0.1";

// Report remote-binding configuration once after HOST is resolved. Both CLI and direct server
// startup load these hooks.
{
  const throttleWarning = remoteThrottleWarning();
  if (throttleWarning) console.warn(`[kozane] ${throttleWarning}`);
}

let registeredRoot: string | null = null;
/**
 * Whether the process exit listener is installed. Register one listener and read the current
 * {@link registeredRoot} when it runs so changing reservations does not accumulate listeners.
 */
let exitHookInstalled = false;
/**
 * Check reservation conflicts lazily so importing the module during a build does not claim
 * the workspace.
 */
let runtimeStateConflict: string | null = null;
let conflictCheckedAt = 0;
/**
 * Delay before retrying a refused workspace reservation or migration check. Separate
 * timestamps let each condition recover independently while limiting repeated filesystem and
 * database work.
 */
const WORKSPACE_RECHECK_MS = 5_000;

/** The reason this process may not serve `root`, or null when it may. */
function registerRuntimeState(root: string | null): string | null {
  if (!root || registeredRoot === root) return null;
  if (runtimeStateConflict && Date.now() - conflictCheckedAt < WORKSPACE_RECHECK_MS)
    return runtimeStateConflict;

  const active = claimServerState(root, process.pid, {
    memory: process.env.KOZANE_MEMORY_MODE === "1",
    databaseUrl: process.env.KOZANE_RUNTIME_DATABASE_URL,
  });
  if (active) {
    const message = `Kozane workspace is already served by process ${active.pid}. Stop that server, or run this one against another workspace.`;
    // Log only new or changed conflicts.
    if (runtimeStateConflict !== message) console.error(`[kozane] ${message}`);
    runtimeStateConflict = message;
    conflictCheckedAt = Date.now();
    return runtimeStateConflict;
  }
  runtimeStateConflict = null;
  // A workspace this process has stopped serving is no longer its to hold, and the hook
  // below only ever releases the current root, so the outgoing one is released here.
  if (registeredRoot) removeServerState(registeredRoot);
  registeredRoot = root;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      if (registeredRoot) removeServerState(registeredRoot);
    });
  }
  return null;
}

/**
 * Cache migration status in this process and periodically recheck stale results so migrations
 * take effect without a restart.
 */
let migrationBlock: { message: string; checkedAt: number } | null = null;
let migrationsVerified = false;

/**
 * Return the reason the workspace database cannot be served, or null when it is ready.
 *
 * Check server startup paths that do not pass through CLI migration validation. Report
 * recoverable workspace conditions as 503 responses.
 */
async function checkMigrations(): Promise<string | null> {
  if (migrationsVerified) return null;
  if (migrationBlock && Date.now() - migrationBlock.checkedAt < WORKSPACE_RECHECK_MS)
    return migrationBlock.message;

  let url: string;
  try {
    url = getDBURL();
  } catch {
    // No workspace at all. Left to the database open below, which already words that case.
    return null;
  }

  // Opening an in-memory database applies its migrations. Skip `getMigrationStatus`, which
  // would inspect a separate empty database and report pending migrations. `kozane open
  // --memory` uses the same exemption.
  if (isMemoryDbUrl(url)) {
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

  // Log only changed status so periodic checks do not repeat the same message.
  if (migrationBlock?.message !== message) console.error(`[kozane] ${message}`);
  migrationBlock = { message, checkedAt: Date.now() };
  return message;
}

/**
 * Apply request gates in this order.
 *
 * 1. Bypass gates during static prerendering.
 *
 * 2. Reserve the workspace.
 *
 * 3. Verify that the key file is readable.
 *
 * 4. Require a key for remote binding.
 *
 * 5. Require TLS for remote binding.
 *
 * 6. Check the Host header for keyless workspaces.
 *
 * 7. Allow the login page without authentication.
 *
 * 8. Authenticate the request.
 *
 * 9. Check migrations.
 *
 * 10. Open the database.
 *
 * Check workspace configuration before serving login. Authenticate before inspecting
 * migrations to avoid opening the database or exposing its migration state to unauthenticated
 * requests.
 */
const handleRequest: Handle = async ({ event, resolve }) => {
  const root = getWorkspaceRoot();

  // Static prerendering makes local requests against the workspace database. Skip
  // authentication and TLS checks so export also works for key-protected workspaces.
  if (isSsgBuild()) {
    event.locals.db = await getDb();
    return resolve(event);
  }

  const conflict = registerRuntimeState(root);
  if (conflict) return applySecurityHeaders(new Response(conflict, { status: 503 }));

  const key = root ? readApiKeyResult(root) : ({ ok: true, key: null } as const);
  if (!key.ok) {
    // Return 503 for an unreadable key file. This workspace condition can clear without
    // restarting because malformed files are reread on subsequent requests.
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
