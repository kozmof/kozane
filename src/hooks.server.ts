import type { Handle } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { getDb } from "./db/client";
import { getWorkspaceRoot } from "./db/internal/config";
import { API_KEY_COOKIE, apiKeysEqual, readApiKey, requestApiKey } from "./lib/server/api-key";
import { removeServerState, writeServerState } from "./lib/server/runtime-state";
import {
  applySecurityHeaders,
  clearAuthFailures,
  recordAuthFailure,
  remoteBindingRequiresApiKey,
  remoteBindingRequiresTls,
} from "./lib/server/security";

// Default to localhost so that running `node build/index.js` directly without
// the CLI never accidentally exposes the server on all interfaces.
// The CLI (kozane open) always sets HOST explicitly, so this is a no-op there.
process.env.HOST ??= "127.0.0.1";

let registeredRoot: string | null = null;
function registerRuntimeState(root: string | null): void {
  if (!root || registeredRoot === root) return;
  writeServerState(root);
  registeredRoot = root;
  process.once("exit", () => removeServerState(root));
}

export const handle: Handle = async ({ event, resolve }) => {
  const root = getWorkspaceRoot();
  registerRuntimeState(root);
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
  if (configuredKey) {
    const queryKey = event.url.searchParams.get("api_key") ?? undefined;
    const suppliedKey = queryKey ?? requestApiKey(event.request, event.cookies.get(API_KEY_COOKIE));
    if (!apiKeysEqual(suppliedKey, configuredKey.apiKey)) {
      const client = event.getClientAddress();
      const retryAfter = recordAuthFailure(client);
      return applySecurityHeaders(
        new Response(retryAfter ? "Too Many Requests" : "Unauthorized", {
          status: retryAfter ? 429 : 401,
          headers: retryAfter
            ? { "retry-after": String(retryAfter) }
            : { "www-authenticate": 'Bearer realm="Kozane"' },
        }),
      );
    }
    clearAuthFailures(event.getClientAddress());
    if (queryKey) {
      const cookie = event.cookies.serialize(API_KEY_COOKIE, configuredKey.apiKey, {
        httpOnly: true,
        sameSite: "strict",
        secure: event.url.protocol === "https:",
        path: "/",
      });
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
