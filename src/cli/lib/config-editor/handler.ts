import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigIssue } from "../../../lib/ui-config.js";
import { fileSignature } from "../../../lib/server/file-signature.js";
import { writeFileAtomic } from "../../../lib/server/atomic-write.js";
import { validateWorkspaceConfig } from "../config-schema.js";
import { CONFIG_FILE, KOZANE_DIR } from "../config.js";
import { contentTypeFor } from "../static-server.js";
import { FIELD_GROUPS, type FieldSpec, configFields } from "./fields.js";

/** Header the page sends the session token in. A custom header also blocks form-based CSRF. */
export const TOKEN_HEADER = "x-kozane-config-token";

export type EditorContext = {
  root: string;
  token: string;
  /** `Host` header values the server answers to, such as `127.0.0.1:41234`. */
  allowedHosts: ReadonlySet<string>;
  /** The built page, `dist/config-editor`: `index.html` and an `assets` directory. */
  assetsDir: string;
};

export type EditorRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type EditorResponse = {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
};

/**
 * The page's scripts and styles are files from the same origin, so nothing inline needs to
 * run. Svelte sets dynamic styles through the CSSOM, which `style-src` does not restrict.
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Vite's hashed output names, such as `index-Dwj_WY_d.js`. No slashes, so no traversal. */
const ASSET_NAME = /^[\w-]+(\.[\w-]+)*$/;

function serveFile(path: string, status = 200): EditorResponse | null {
  let body: Buffer;
  try {
    body = readFileSync(path);
  } catch {
    return null;
  }
  return {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": contentTypeFor(path),
      "Content-Security-Policy": PAGE_CSP,
    },
    body,
  };
}

function servePage(ctx: EditorContext, pathname: string): EditorResponse {
  if (pathname === "/") {
    return (
      serveFile(join(ctx.assetsDir, "index.html")) ??
      failure(503, "The config page is not built. Run `pnpm build`, then try again.")
    );
  }
  const name = pathname.slice("/assets/".length);
  if (!ASSET_NAME.test(name)) return failure(404, "Not found");
  return serveFile(join(ctx.assetsDir, "assets", name)) ?? failure(404, "Not found");
}

/** What the page needs to render the form. */
export type ConfigSnapshot = {
  path: string;
  /** File signature when read. Sent back on save to detect edits made elsewhere. */
  signature: string | null;
  groups: readonly string[];
  fields: FieldSpec[];
  /** Raw value of each field in the file, keyed by path. Absent keys are left out. */
  values: Record<string, unknown>;
  issues: ConfigIssue[];
  /** Set when the file is missing or is not a JSON object. The form is read-only then. */
  readError?: string;
};

export type SaveRequest = {
  signature: string | null;
  /** New value per field path. `null` removes the key so its default applies. */
  changes: Record<string, unknown>;
};

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // The page URL carries the session token, so never send it on as a referrer.
  "Referrer-Policy": "no-referrer",
};

function json(status: number, body: unknown): EditorResponse {
  return {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function failure(status: number, message: string, extra: object = {}): EditorResponse {
  return json(status, { error: message, ...extra });
}

function header(request: EditorRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configFilePath(root: string): string {
  return join(root, KOZANE_DIR, CONFIG_FILE);
}

function getPath(raw: Record<string, unknown>, path: string): unknown {
  let node: unknown = raw;
  for (const key of path.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Set or remove (`null`) a dotted path, replacing any non-object along the way. */
function setPath(raw: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let node = raw;
  for (const key of keys) {
    if (!isPlainObject(node[key])) {
      if (value === null) return;
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  if (value === null) delete node[last];
  else node[last] = value;
}

type ReadResult =
  | { ok: true; raw: Record<string, unknown>; signature: string | null }
  | { ok: false; error: string; signature: string | null };

function readRaw(path: string): ReadResult {
  const signature = fileSignature(path);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return { ok: false, signature, error: `Cannot read ${path}: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      signature,
      error: `${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`,
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, signature, error: `${CONFIG_FILE} must hold a JSON object` };
  }
  return { ok: true, raw: parsed, signature };
}

export function readSnapshot(root: string): ConfigSnapshot {
  const path = configFilePath(root);
  const fields = configFields();
  const base = { path, groups: FIELD_GROUPS, fields };
  const read = readRaw(path);
  if (!read.ok) {
    return { ...base, signature: read.signature, values: {}, issues: [], readError: read.error };
  }
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const value = getPath(read.raw, field.path);
    if (value !== undefined) values[field.path] = value;
  }
  return {
    ...base,
    signature: read.signature,
    values,
    issues: validateWorkspaceConfig(read.raw).issues,
  };
}

/**
 * Apply `changes` to the file as it is now and write it back. Unknown keys and fields the
 * page did not touch are kept as they are. Refuse when the result has errors, or when the file
 * changed since the page read it.
 */
export function saveChanges(root: string, request: unknown): EditorResponse {
  if (!isPlainObject(request) || !isPlainObject(request.changes)) {
    return failure(400, "Expected a JSON object with signature and changes");
  }
  const { changes } = request;
  const path = configFilePath(root);
  const read = readRaw(path);
  if (!read.ok) return failure(409, read.error);
  if (request.signature !== read.signature) {
    return failure(
      409,
      `${CONFIG_FILE} changed on disk since this page loaded it. Reload to see the current file.`,
    );
  }

  const fields = new Map(configFields().map((field) => [field.path, field]));
  for (const [fieldPath, value] of Object.entries(changes)) {
    const field = fields.get(fieldPath);
    if (!field) return failure(400, `${fieldPath} is not a setting this page can change`);
    if (value === null && field.required) return failure(400, `${fieldPath} is required`);
    setPath(read.raw, fieldPath, value);
  }

  const { issues } = validateWorkspaceConfig(read.raw);
  if (issues.some((issue) => issue.severity === "error")) {
    return json(422, { error: "Fix the errors below, then save again.", issues });
  }

  writeFileAtomic(path, JSON.stringify(read.raw, null, 2) + "\n");
  return json(200, { saved: true, snapshot: readSnapshot(root) });
}

export function handleConfigRequest(ctx: EditorContext, request: EditorRequest): EditorResponse {
  // Refuse other host names so a DNS-rebinding page cannot reach the server by name.
  const host = header(request, "host");
  if (!host || !ctx.allowedHosts.has(host.toLowerCase())) {
    return failure(421, "Unexpected Host header");
  }

  const pathname = request.url.split("?")[0];

  if (pathname === "/" || pathname.startsWith("/assets/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return failure(405, "Method not allowed");
    }
    return servePage(ctx, pathname);
  }

  if (pathname !== "/api/config") return failure(404, "Not found");
  if (!tokenMatches(ctx.token, header(request, TOKEN_HEADER))) {
    return failure(
      403,
      "Missing or wrong session token. Open the link printed by `kozane config open`.",
    );
  }

  if (request.method === "GET") return json(200, readSnapshot(ctx.root));
  if (request.method === "PUT") {
    const origin = header(request, "origin");
    if (origin !== undefined && !ctx.allowedHosts.has(origin.replace(/^http:\/\//, ""))) {
      return failure(403, "Cross-origin request refused");
    }
    if (!header(request, "content-type")?.startsWith("application/json")) {
      return failure(415, "Expected application/json");
    }
    let body: unknown;
    try {
      body = JSON.parse(request.body);
    } catch {
      return failure(400, "Request body is not valid JSON");
    }
    return saveChanges(ctx.root, body);
  }
  return failure(405, "Method not allowed");
}
