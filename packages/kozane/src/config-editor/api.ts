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

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

/** The server's error text, or `fallback` when the body carries none. */
function errorText(data: unknown, fallback: string): string {
  const error = field(data, "error");
  return typeof error === "string" && error !== "" ? error : fallback;
}

/**
 * A config snapshot from the server. The server owns its shape, so check only that it is an
 * object. A body that is not one means the server is not the config editor.
 */
function asSnapshot(data: unknown): ConfigSnapshot | undefined {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as ConfigSnapshot)
    : undefined;
}

async function call(
  token: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { [TOKEN_HEADER]: token };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch("/api/config", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as unknown };
}

export async function loadConfig(token: string): Promise<LoadResult> {
  try {
    const { status, data } = await call(token, "GET");
    const snapshot = status === 200 ? asSnapshot(data) : undefined;
    if (!snapshot) return { ok: false, error: errorText(data, "Could not load the config.") };
    return { ok: true, snapshot };
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
    const snapshot = status === 200 ? asSnapshot(field(data, "snapshot")) : undefined;
    if (snapshot) return { ok: true, snapshot };
    const issues = field(data, "issues");
    return {
      ok: false,
      error: errorText(data, "Could not save the config."),
      issues: Array.isArray(issues) ? (issues as ConfigIssue[]) : undefined,
    };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}
