import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const API_KEY_FILE = "api.json";
export const API_KEY_COOKIE = "kozane_api_key";
export type ApiKeyFile = { apiKey: string; createdAt: string };

export function apiKeyPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".kozane", API_KEY_FILE);
}

export function readApiKey(workspaceRoot: string): ApiKeyFile | null {
  const path = apiKeyPath(workspaceRoot);
  if (!existsSync(path)) return null;
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
    throw new Error("Invalid Kozane API key: apiKey must be a non-empty string");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("Invalid Kozane API key: createdAt must be an ISO date string");
  }
  return { apiKey: value.apiKey, createdAt: value.createdAt };
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
