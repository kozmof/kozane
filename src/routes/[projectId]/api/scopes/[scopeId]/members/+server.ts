import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addScopeRel } from "../../../../../../db/api/scope-rel";
import { bundleTable, cardTable } from "../../../../../../db/schema";
import { and, eq, inArray } from "drizzle-orm";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, scopeId } = params;
  const body = await request.json();
  const { cardIds } = body;

  if (!Array.isArray(cardIds) || cardIds.length === 0)
    throw error(400, "cardIds is required");

  const found = await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .innerJoin(
      bundleTable,
      and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
    )
    .where(inArray(cardTable.id, cardIds));

  if (found.length !== cardIds.length) throw error(400, "Some cards not found in project");

  for (const { id: cardId } of found) {
    await addScopeRel({ db, scopeId, cardId });
  }

  return json({ ok: true });
};
