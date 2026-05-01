import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { bundleTable, cardTable } from "../../../../db/schema";
import { and, eq } from "drizzle-orm";
import { CANVAS_W, CANVAS_H, CONTENT_MAX, clamp } from "$lib/constants";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await request.json();
  const { bundleId, content, posX = 0, posY = 0 } = body;

  if (!bundleId || !content) throw error(400, "bundleId and content are required");
  if (typeof content !== "string" || content.length > CONTENT_MAX)
    throw error(400, `content must be a string under ${CONTENT_MAX} characters`);

  const bundle = await db
    .select({ id: bundleTable.id })
    .from(bundleTable)
    .where(and(eq(bundleTable.id, bundleId), eq(bundleTable.projectId, projectId)))
    .get();

  if (!bundle) throw error(400, "Bundle not found in project");

  const [row] = await db
    .insert(cardTable)
    .values({ bundleId, content, posX: clamp(posX, 0, CANVAS_W), posY: clamp(posY, 0, CANVAS_H) })
    .returning({ id: cardTable.id });

  return json({ id: row.id });
};
