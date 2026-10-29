import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addPartition } from "$db/api/partition";
import { isUniqueConstraintError } from "$db/api/utils";
import { readJsonObject, requireBoundedName } from "../../lib/request.js";
import { apiHandler } from "../../lib/api-handler.js";

export const POST: RequestHandler = apiHandler(
  async ({ locals, params, request }) => {
    const { db } = locals;
    const { namespaceId } = params;
    const body = await readJsonObject(request);
    const name = requireBoundedName(body);

    try {
      const id = await addPartition({ db, namespaceId, name });
      return json({ id });
    } catch (e) {
      if (isUniqueConstraintError(e))
        throw error(400, `A partition named "${name}" already exists`);
      throw e;
    }
  },
  { foreignKey: "Namespace not found" },
);
