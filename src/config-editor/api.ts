import type { ConfigIssue } from "../lib/ui-config.js";
import type { ConfigSnapshot } from "../cli/lib/config-editor/handler.js";
import type { Changes } from "./edit-state.js";

/** Must match `TOKEN_HEADER` in the handler, which this browser code cannot import. */
const TOKEN_HEADER = "X-Kozane-Config-Token";

export type LoadResult = { ok: true; snapshot: ConfigSnapshot } | { ok: false; error: string };

export type SaveResult =
  | { ok: true; snapshot: ConfigSnapshot }
  | { ok: false; error: string; issues?: ConfigIssue[] };

export const UNREACHABLE =
  "Could not reach the config server. Keep kozane config open running, then reload this page.";

async function call(
  token: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { [TOKEN_HEADER]: token };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch("/api/config", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

export async function loadConfig(token: string): Promise<LoadResult> {
  try {
    const { status, data } = await call(token, "GET");
    if (status !== 200) return { ok: false, error: data.error ?? "Could not load the config." };
    return { ok: true, snapshot: data };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

export async function saveConfig(
  token: string,
  signature: string | null,
  changes: Changes,
): Promise<SaveResult> {
  try {
    const { status, data } = await call(token, "PUT", { signature, changes });
    if (status === 200) return { ok: true, snapshot: data.snapshot };
    return { ok: false, error: data.error ?? "Could not save the config.", issues: data.issues };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}
