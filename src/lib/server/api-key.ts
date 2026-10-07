import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileSignature } from "./file-signature.js";
import { writeFileAtomic } from "./atomic-write.js";

export const API_KEY_FILE = "api.json";
export const API_KEY_COOKIE = "kozane_api_key";
export type ApiKeyFile = { apiKey: string; createdAt: string };

export function apiKeyPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".kozane", API_KEY_FILE);
}

/** Writes a key file without exposing partial contents after a crash or disk-full error. */
export function writeApiKey(workspaceRoot: string, value: ApiKeyFile): void {
  // Restrict access to the owner because this file holds the workspace credential.
  writeFileAtomic(apiKeyPath(workspaceRoot), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * Cache each workspace's parsed key with its file signature. Check the signature on access so
 * atomic key replacement takes effect on the next request without reading and parsing
 * unchanged content.
 */
type CachedApiKey = { signature: string; value: ApiKeyFile };
const apiKeyCache = new Map<string, CachedApiKey>();

export function _resetApiKeyCacheForTest(): void {
  apiKeyCache.clear();
}

export function readApiKey(workspaceRoot: string): ApiKeyFile | null {
  const path = apiKeyPath(workspaceRoot);
  const signature = fileSignature(path);
  if (signature === null) {
    apiKeyCache.delete(path);
    return null;
  }
  const cached = apiKeyCache.get(path);
  if (cached && cached.signature === signature) return cached.value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`Invalid Kozane API key file at ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Kozane API key file at ${path}`);
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.apiKey !== "string" || value.apiKey.length === 0) {
    throw new Error(`Invalid Kozane API key at ${path}: apiKey must be a non-empty string`);
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error(`Invalid Kozane API key at ${path}: createdAt must be an ISO date string`);
  }
  // Frozen because every caller from here on is handed the same object rather than a fresh
  // parse of the file, and a shared value that can be written through is a trap.
  const result: ApiKeyFile = Object.freeze({ apiKey: value.apiKey, createdAt: value.createdAt });
  // Cache only successfully parsed files so repairing a malformed file takes effect without a
  // restart.
  apiKeyCache.set(path, { signature, value: result });
  return result;
}

export type ApiKeyResult =
  /** `key` is null when the workspace simply has no key file, which is the ordinary case. */
  { ok: true; key: ApiKeyFile | null } | { ok: false; message: string };

/**
 * Return the workspace key or a readable failure reason. Use this result where callers must
 * report a workspace error instead of propagating an exception.
 */
export function readApiKeyResult(workspaceRoot: string): ApiKeyResult {
  try {
    return { ok: true, key: readApiKey(workspaceRoot) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function apiKeysEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function requestApiKey(request: Request, cookieValue?: string): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.headers.get("x-api-key") ?? cookieValue ?? undefined;
}

export type ApiKeyCookieOptions = {
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  path: "/";
};

// Shared cookie attributes so the query-key exchange (hooks.server) and the
// login form action set the API-key cookie identically. `secure` is derived
// from the request protocol so the cookie works over plain HTTP on loopback.
export function apiKeyCookieOptions(secure: boolean): ApiKeyCookieOptions {
  return { httpOnly: true, sameSite: "strict", secure, path: "/" };
}
