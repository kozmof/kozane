import { apiHandler } from "$lib/server/http/api-handler.js";
import type { RequestHandler } from "./$types";
import { getWorkspaceRoot } from "../../../../db/internal/config.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { error } from "@sveltejs/kit";
export const GET: RequestHandler = apiHandler(async ({ params }) => {
  if (!/^[a-f0-9-]{36}\.(jpg|jpeg|png|svg)$/.test(params.name)) error(404);
  const root = getWorkspaceRoot();
  if (!root) error(500, "Workspace not found");
  let data;
  try {
    data = await readFile(resolve(root, ".kozane/assets/images", params.name));
  } catch {
    error(404);
  }
  const extension = params.name.split(".").pop();
  return new Response(data, {
    headers: {
      "Content-Type":
        extension === "svg" ? "image/svg+xml" : extension === "png" ? "image/png" : "image/jpeg",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});
