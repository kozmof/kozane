import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: null as string | null }));
vi.mock("./db/internal/config", () => ({ getWorkspaceRoot: () => state.root }));
vi.mock("./db/client", () => ({ getDb: vi.fn(async () => ({ ready: true })) }));

import { handle } from "./hooks.server";
import { AUTH_FAILURE_LIMIT, _resetAuthFailuresForTest } from "./lib/server/security";

function workspace(apiKey?: string): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-hook-"));
  mkdirSync(join(root, ".kozane"));
  if (apiKey) {
    writeFileSync(
      join(root, ".kozane", "api.json"),
      JSON.stringify({ apiKey, createdAt: new Date().toISOString() }),
    );
  }
  return root;
}

function event(url = "http://localhost/", headers?: HeadersInit) {
  const cookies = new Map<string, string>();
  return {
    url: new URL(url),
    request: new Request(url, { headers }),
    locals: {},
    cookies: {
      get: (name: string) => cookies.get(name),
      set: (name: string, value: string) => cookies.set(name, value),
      serialize: (name: string, value: string) =>
        `${name}=${value}; Path=/; HttpOnly; SameSite=Strict`,
    },
    getClientAddress: () => "127.0.0.1",
  };
}

describe("production request hook", () => {
  beforeEach(() => {
    process.env.HOST = "127.0.0.1";
    state.root = workspace();
    _resetAuthFailuresForTest();
  });

  it("fails closed when a remotely bound server has no API key", async () => {
    process.env.HOST = "0.0.0.0";
    const response = await handle({
      event: event() as never,
      resolve: vi.fn() as never,
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("requires a Kozane API key");
  });

  it("fails closed over HTTP when remotely bound", async () => {
    process.env.HOST = "0.0.0.0";
    state.root = workspace("secret");
    const response = await handle({
      event: event("http://example.test/", { authorization: "Bearer secret" }) as never,
      resolve: vi.fn() as never,
    });
    expect(response.status).toBe(426);
    expect(await response.text()).toContain("requires HTTPS");
  });

  it("accepts authenticated HTTPS when remotely bound", async () => {
    process.env.HOST = "0.0.0.0";
    state.root = workspace("secret");
    const resolve = vi.fn(async () => new Response("ok"));
    const response = await handle({
      event: event("https://example.test/", { authorization: "Bearer secret" }) as never,
      resolve: resolve as never,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("returns 401 to unauthenticated API clients and authenticates a valid bearer key", async () => {
    state.root = workspace("secret");
    const unauthorized = await handle({
      event: event("http://localhost/", { accept: "application/json" }) as never,
      resolve: vi.fn() as never,
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe('Bearer realm="Kozane"');

    const resolve = vi.fn(async () => new Response("ok"));
    const authenticated = await handle({
      event: event("http://localhost/", { authorization: "Bearer secret" }) as never,
      resolve: resolve as never,
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("x-frame-options")).toBe("DENY");
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("redirects an unauthenticated browser navigation to the login page", async () => {
    state.root = workspace("secret");
    const response = await handle({
      event: event("http://localhost/project?view=all", { accept: "text/html" }) as never,
      resolve: vi.fn() as never,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/login?next=" + encodeURIComponent("/project?view=all"),
    );
  });

  it("lets the login page through without a valid key", async () => {
    state.root = workspace("secret");
    const resolve = vi.fn(async () => new Response("login"));
    const response = await handle({
      event: event("http://localhost/login?next=%2F", { accept: "text/html" }) as never,
      resolve: resolve as never,
    });
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("returns 429 rather than redirecting once the failure limit trips", async () => {
    state.root = workspace("secret");
    let last: Response | undefined;
    for (let i = 0; i <= AUTH_FAILURE_LIMIT; i++) {
      last = await handle({
        event: event("http://localhost/", { accept: "text/html" }) as never,
        resolve: vi.fn() as never,
      });
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBeTruthy();
  });

  it("exchanges a query key for a protected cookie and clean redirect", async () => {
    state.root = workspace("secret");
    const response = await handle({
      event: event("http://localhost/project?api_key=secret&view=all") as never,
      resolve: vi.fn() as never,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/project?view=all");
    expect(response.headers.get("set-cookie")).toBe(
      "kozane_api_key=secret; Path=/; HttpOnly; SameSite=Strict",
    );
  });
});
