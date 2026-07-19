import { sql } from "drizzle-orm";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  await locals.db.run(sql.raw("select 1"));
  return json({ status: "ok" });
};
