import type { Handle } from "@sveltejs/kit";
import { db } from "./db/client";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.db = db;
  return resolve(event);
};
