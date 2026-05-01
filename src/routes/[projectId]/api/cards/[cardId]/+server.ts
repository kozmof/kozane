import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { bundleTable, cardTable } from "../../../../../db/schema";
import { and, eq } from "drizzle-orm";

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

  const updates: Record<string, unknown> = {};
  if (body.content !== undefined) updates.content = body.content;
  if (body.posX !== undefined) updates.posX = body.posX;
  if (body.posY !== undefined) updates.posY = body.posY;

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
