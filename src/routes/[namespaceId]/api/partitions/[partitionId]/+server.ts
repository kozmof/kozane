import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { updatePartitionName } from "$db/api/partition";
import { deletePartitionWithReassign } from "$db/api/composite";
import { isUniqueConstraintError } from "$db/api/utils";
import { readJsonObject, requireBoundedName } from "../../../lib/request.js";
import { apiHandler } from "../../../lib/api-handler.js";

export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, partitionId } = params;
  const body = await readJsonObject(request);
  const name = requireBoundedName(body);

  try {
    await updatePartitionName({ db, namespaceId, partitionId, name });
  } catch (e) {
    if (isUniqueConstraintError(e)) throw error(400, `A partition named "${name}" already exists`);
    throw e;
  }
  return json({ ok: true });
});

export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, partitionId } = params;

  const { defaultPartitionId } = await deletePartitionWithReassign({
    db,
    namespaceId,
    partitionId,
  });
  return json({ ok: true, defaultPartitionId });
});
