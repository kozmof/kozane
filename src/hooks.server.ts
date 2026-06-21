import type { Handle } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { getDb } from "./db/client";

// Default to localhost so that running `node build/index.js` directly without
// the CLI never accidentally exposes the server on all interfaces.
// The CLI (kozane open) always sets HOST explicitly, so this is a no-op there.
process.env.HOST ??= "127.0.0.1";

export const handle: Handle = async ({ event, resolve }) => {
  try {
    event.locals.db = await getDb();
  } catch {
    throw error(503, "No Kozane workspace found. Run 'kozane init' first.");
  }
  return resolve(event);
};
