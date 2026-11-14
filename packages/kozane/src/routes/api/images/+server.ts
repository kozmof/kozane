import { IMAGE_MAX_BYTES } from "@kozane/core";
import { apiHandler } from "$lib/server/http/api-handler.js";
import type { RequestHandler } from "./$types";
import { getWorkspaceRoot } from "../../../db/internal/config.js";
import { storeImage, collectUnusedImages } from "$lib/server/image-assets.js";

import { error, json } from "@sveltejs/kit";
export const POST: RequestHandler = apiHandler(async ({ request, locals }) => {
  const form = await request.formData();
  const file = form.get("image");
  if (!(file instanceof File)) error(400, "Choose an image");
  if (file.size === 0 || file.size > IMAGE_MAX_BYTES)
    error(400, "Image must be between 1 byte and 10 MiB");
  const root = getWorkspaceRoot();
  if (!root) error(500, "Workspace not found");
  let url: string;
  try {
    url = await storeImage(root, file.name, new Uint8Array(await file.arrayBuffer()));
  } catch (cause) {
    error(400, cause instanceof Error ? cause.message : "Invalid image");
  }
  await collectUnusedImages(root, locals.db).catch(() => {});
  return json({ url });
});
