import type { Handle } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { getDb } from "./db/client";

export const handle: Handle = async ({ event, resolve }) => {
  try {
    event.locals.db = await getDb();
  } catch {
    throw error(503, "No Kozane workspace found. Run 'kozane init' first.");
  }
  return resolve(event);
};
