import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { bundleTable, cardTable } from "../../../../../db/schema";
import { and, eq } from "drizzle-orm";
import { CANVAS_W, CANVAS_H, CONTENT_MAX, clamp } from "$lib/constants";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, cardId } = params;
  const body = await request.json();

  const card = await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .innerJoin(
      bundleTable,
      and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
    )
    .where(eq(cardTable.id, cardId))
    .get();

  if (!card) throw error(404, "Card not found");

  if (body.content !== undefined) {
    if (typeof body.content !== "string" || body.content.length > CONTENT_MAX)
      throw error(400, `content must be a string under ${CONTENT_MAX} characters`);
  }

  const updates: Record<string, unknown> = {};
  if (body.content !== undefined) updates.content = body.content;
  if (body.posX !== undefined) updates.posX = clamp(body.posX, 0, CANVAS_W);
  if (body.posY !== undefined) updates.posY = clamp(body.posY, 0, CANVAS_H);

  if (body.bundleId !== undefined) {
    const newBundle = await db
      .select({ id: bundleTable.id })
      .from(bundleTable)
      .where(and(eq(bundleTable.id, body.bundleId), eq(bundleTable.projectId, projectId)))
      .get();
    if (!newBundle) throw error(400, "New bundle not found in project");
    updates.bundleId = body.bundleId;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(cardTable).set(updates).where(eq(cardTable.id, cardId));
  }

  return json({ ok: true });
};
