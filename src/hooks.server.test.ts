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
    vi.restoreAllMocks();
    process.env.HOST = "127.0.0.1";
    delete process.env.KOZANE_LOG_REQUESTS;
    state.root = workspace();
    _resetAuthFailuresForTest();
  });

  it("does not log successful requests by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handle({
      event: event() as never,
      resolve: vi.fn(async () => new Response("ok")) as never,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("logs successful requests when request logging is enabled", async () => {
    process.env.KOZANE_LOG_REQUESTS = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handle({
      event: event("http://localhost/project") as never,
      resolve: vi.fn(async () => new Response("ok")) as never,
    });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      level: "info",
      event: "http_request",
      method: "GET",
      path: "/project",
      status: 200,
    });
  });

  it("answers 503 naming the file when the API key cannot be read", async () => {
    const root = workspace();
    // What a hand-edit leaves behind. Unguarded this threw out of the hook, and every
    // page load and every poll became a 500 that said nothing about the file behind it.
    writeFileSync(join(root, ".kozane", "api.json"), "{not json");
    state.root = root;

    const resolver = vi.fn();
    const response = await handle({
      event: event() as never,
      resolve: resolver as never,
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("api.json");
    // The request never reached the app: an unreadable key means nothing can be authorised.
    expect(resolver).not.toHaveBeenCalled();
  });

  it("serves normally again once a malformed API key file is repaired", async () => {
    const root = workspace();
    const path = join(root, ".kozane", "api.json");
    writeFileSync(path, "{not json");
    state.root = root;
    expect((await handle({ event: event() as never, resolve: vi.fn() as never })).status).toBe(503);

    // No restart: `readApiKey` never caches a file that failed to parse, so the repair
    // takes effect on the very next request.
    writeFileSync(path, JSON.stringify({ apiKey: "fixed", createdAt: new Date().toISOString() }));

    const response = await handle({
      event: event("http://localhost/", { authorization: "Bearer fixed" }) as never,
      resolve: vi.fn(async () => new Response("ok")) as never,
    });
    expect(response.status).toBe(200);
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

/**
 * The gate for the one mode with no credential to check. A keyless workspace on loopback
 * authenticates nobody, so a name pointed at this address by DNS rebinding would otherwise
 * read the whole board over ordinary `GET`s — which SvelteKit's CSRF origin check does not
 * cover.
 */
describe("keyless workspace host gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.HOST = "127.0.0.1";
    delete process.env.KOZANE_ALLOWED_HOSTS;
    state.root = workspace();
    _resetAuthFailuresForTest();
  });

  it("serves a request that arrived on a loopback name", async () => {
    const response = await handle({
      event: event("http://localhost/", { host: "127.0.0.1:17173" }) as never,
      resolve: vi.fn(async () => new Response("ok")) as never,
    });
    expect(response.status).toBe(200);
  });

  it("refuses a request that arrived under someone else's name", async () => {
    const resolve = vi.fn(async () => new Response("ok"));
    const response = await handle({
      event: event("http://localhost/", { host: "attacker.example" }) as never,
      resolve: resolve as never,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("attacker.example");
    // The board was never assembled, let alone sent.
    expect(resolve).not.toHaveBeenCalled();
  });

  it("serves a host named in KOZANE_ALLOWED_HOSTS", async () => {
    process.env.KOZANE_ALLOWED_HOSTS = "kozane.local";
    const response = await handle({
      event: event("http://localhost/", { host: "kozane.local" }) as never,
      resolve: vi.fn(async () => new Response("ok")) as never,
    });
    expect(response.status).toBe(200);
  });

  // With a key configured the key is the defence, and the cookie belongs to the loopback
  // origin so a rebound page never receives it. Named hosts must keep working there —
  // that is the documented reverse-proxy deployment.
  it("does not apply to a workspace that has an API key", async () => {
    state.root = workspace("secret");
    const response = await handle({
      event: event("http://kozane.example/", {
        host: "kozane.example",
        authorization: "Bearer secret",
      }) as never,
      resolve: vi.fn(async () => new Response("ok")) as never,
    });
    expect(response.status).toBe(200);
  });
});
