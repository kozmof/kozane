/** Shared request plumbing for the namespace API clients in this folder. */
import { base } from "$app/paths";
import { byteLength } from "$lib/byte-length.js";

/** Build a namespace endpoint URL with the configured base path. */
export function apiUrl(namespaceId: string, path: string): string {
  return `${base}/${namespaceId}/api${path}`;
}

export function jsonRequest(
  fetcher: typeof fetch,
  url: string,
  method: string,
  body?: unknown,
  { keepalive = false }: RequestOptions = {},
): Promise<Response> {
  const json = body === undefined ? undefined : JSON.stringify(body);
  return fetcher(url, {
    method,
    ...(json !== undefined && { headers: { "Content-Type": "application/json" }, body: json }),
    // Browsers refuse a keepalive request over their body quota, so send a larger one as usual.
    ...(keepalive && json !== undefined && fitsKeepalive(json) && { keepalive: true }),
  });
}

/** Options for a request that may be sent as the page goes away. */
export type RequestOptions = {
  /** Let the request outlive the page, for a save sent as the tab closes. Small bodies only. */
  keepalive?: boolean;
};

/** See {@link saveTaskspaceFile}. */
export type SaveOptions = RequestOptions;

/** Kept under the 64 KiB that browsers allow keepalive request bodies in flight. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

/**
 * Whether `json` is within {@link KEEPALIVE_MAX_BYTES}. A UTF-16 code unit is one to three
 * UTF-8 bytes, so most bodies are decided by length alone without encoding them.
 */
function fitsKeepalive(json: string): boolean {
  if (json.length > KEEPALIVE_MAX_BYTES) return false;
  if (json.length * 3 <= KEEPALIVE_MAX_BYTES) return true;
  return byteLength(json) <= KEEPALIVE_MAX_BYTES;
}

/** Read the server's failure message so callers can show specific recovery guidance. */
export async function failureMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}
