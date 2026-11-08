import { error } from "@sveltejs/kit";
type JsonRecord = Record<string, unknown>;

/**
 * Require `application/json` and read an object body. This forces cross-origin browser
 * requests through CORS preflight instead of accepting simple requests that `request.json()`
 * could otherwise parse.
 */
export async function readJsonObject(request: Request): Promise<JsonRecord> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw error(415, "Request body must be sent as application/json");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, "Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw error(400, "Request body must be a JSON object");
  }
  return body as JsonRecord;
}
