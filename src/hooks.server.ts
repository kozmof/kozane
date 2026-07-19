import type { Handle } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { getDb } from "./db/client";
import { getWorkspaceRoot } from "./db/internal/config";
import { API_KEY_COOKIE, apiKeysEqual, readApiKey, requestApiKey } from "./lib/server/api-key";

// Default to localhost so that running `node build/index.js` directly without
// the CLI never accidentally exposes the server on all interfaces.
// The CLI (kozane open) always sets HOST explicitly, so this is a no-op there.
process.env.HOST ??= "127.0.0.1";

export const handle: Handle = async ({ event, resolve }) => {
  const root = getWorkspaceRoot();
  const configuredKey = root ? readApiKey(root) : null;
  if (configuredKey) {
    const queryKey = event.url.searchParams.get("api_key") ?? undefined;
    const suppliedKey = queryKey ?? requestApiKey(event.request, event.cookies.get(API_KEY_COOKIE));
    if (!apiKeysEqual(suppliedKey, configuredKey.apiKey)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="Kozane"' },
      });
    }
    if (queryKey) {
      event.cookies.set(API_KEY_COOKIE, configuredKey.apiKey, {
        httpOnly: true,
        sameSite: "strict",
        secure: event.url.protocol === "https:",
        path: "/",
      });
      const cleanUrl = new URL(event.url);
      cleanUrl.searchParams.delete("api_key");
      return new Response(null, {
        status: 303,
        headers: { location: cleanUrl.pathname + cleanUrl.search },
      });
    }
  }
  try {
    event.locals.db = await getDb();
  } catch (e) {
    console.error("[kozane] Failed to open database:", e);
    throw error(503, "No Kozane workspace found. Run 'kozane init' first.");
  }
  return resolve(event);
};
