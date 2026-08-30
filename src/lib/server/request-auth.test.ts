import { beforeEach, describe, expect, it } from "vitest";
import { authenticateRequest } from "./request-auth.js";
import { API_KEY_COOKIE, type ApiKeyFile } from "./api-key.js";
import { AUTH_FAILURE_LIMIT, _resetAuthFailuresForTest } from "./security.js";

const KEY: ApiKeyFile = { apiKey: "correct-horse", createdAt: new Date().toISOString() };

type EventOptions = {
  url?: string;
  headers?: HeadersInit;
  cookie?: string;
  client?: string;
  method?: string;
};

function event({
  url = "http://localhost/board",
  headers,
  cookie,
  client,
  method,
}: EventOptions = {}) {
  const cookies = new Map<string, string>();
  if (cookie) cookies.set(API_KEY_COOKIE, cookie);
  return {
    url: new URL(url),
    request: new Request(url, { headers, method, ...(method === "POST" && { body: "{}" }) }),
    cookies: {
      get: (name: string) => cookies.get(name),
      serialize: (name: string, value: string) =>
        `${name}=${value}; Path=/; HttpOnly; SameSite=Strict`,
    },
    getClientAddress: () => client ?? "127.0.0.1",
  } as never;
}

const NAVIGATION = { "sec-fetch-mode": "navigate" };

beforeEach(() => _resetAuthFailuresForTest());

describe("authenticateRequest", () => {
  it("passes a request carrying the key as a bearer token", () => {
    const outcome = authenticateRequest(
      event({ headers: { authorization: `Bearer ${KEY.apiKey}` } }),
      KEY,
    );
    expect(outcome).toEqual({ kind: "pass" });
  });

  it("passes a request carrying the key as a cookie", () => {
    expect(authenticateRequest(event({ cookie: KEY.apiKey }), KEY)).toEqual({ kind: "pass" });
  });

  it("passes a request carrying the key in the X-API-Key header", () => {
    const outcome = authenticateRequest(event({ headers: { "x-api-key": KEY.apiKey } }), KEY);
    expect(outcome).toEqual({ kind: "pass" });
  });

  it("answers an API client with 401 and a challenge", () => {
    const outcome = authenticateRequest(event({ headers: { authorization: "Bearer wrong" } }), KEY);
    expect(outcome.kind).toBe("respond");
    if (outcome.kind !== "respond") return;
    expect(outcome.response.status).toBe(401);
    expect(outcome.response.headers.get("www-authenticate")).toBe('Bearer realm="Kozane"');
  });

  it("sends an unauthenticated browser navigation to the login page", () => {
    const outcome = authenticateRequest(
      event({ url: "http://localhost/board?zoom=2", headers: NAVIGATION }),
      KEY,
    );
    expect(outcome.kind).toBe("respond");
    if (outcome.kind !== "respond") return;
    expect(outcome.response.status).toBe(303);
    expect(outcome.response.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent("/board?zoom=2")}`,
    );
  });

  it("rate-limits before it redirects, so a loop cannot bypass the limiter", () => {
    for (let attempt = 0; attempt <= AUTH_FAILURE_LIMIT; attempt++) {
      authenticateRequest(event({ headers: NAVIGATION }), KEY);
    }
    const outcome = authenticateRequest(event({ headers: NAVIGATION }), KEY);
    expect(outcome.kind).toBe("respond");
    if (outcome.kind !== "respond") return;
    expect(outcome.response.status).toBe(429);
    expect(Number(outcome.response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("clears a client's failures once it gets the key right", () => {
    for (let attempt = 0; attempt < AUTH_FAILURE_LIMIT; attempt++) {
      authenticateRequest(event({ headers: { authorization: "Bearer wrong" } }), KEY);
    }
    expect(authenticateRequest(event({ cookie: KEY.apiKey }), KEY)).toEqual({ kind: "pass" });
    // The count is back to zero, so the next wrong guess is a 401 rather than a 429.
    const outcome = authenticateRequest(event({ headers: { authorization: "Bearer wrong" } }), KEY);
    expect(outcome.kind === "respond" && outcome.response.status).toBe(401);
  });

  it("exchanges a key in the query for the cookie and drops it from the URL", () => {
    const outcome = authenticateRequest(
      event({ url: `http://localhost/board?api_key=${KEY.apiKey}&zoom=2` }),
      KEY,
    );
    expect(outcome.kind).toBe("respond");
    if (outcome.kind !== "respond") return;
    expect(outcome.response.status).toBe(303);
    expect(outcome.response.headers.get("location")).toBe("/board?zoom=2");
    const cookie = outcome.response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${API_KEY_COOKIE}=${KEY.apiKey}`);
    expect(cookie).toContain("HttpOnly");
  });

  // The exchange answers 303, and a 303 turns the retry into a GET — so a POST that
  // authenticated this way was answered with a redirect that dropped its body, and the write
  // it carried never happened. Only `kozane open` ever puts a key in a URL, and that is a
  // GET; anything else is authenticated and served, cookie or no cookie.
  it("serves a non-GET carrying the key in the query rather than redirecting it", () => {
    const outcome = authenticateRequest(
      event({ url: `http://localhost/board?api_key=${KEY.apiKey}`, method: "POST" }),
      KEY,
    );
    expect(outcome).toEqual({ kind: "pass" });
  });

  it("does not exchange a wrong key in the query", () => {
    const outcome = authenticateRequest(
      event({ url: "http://localhost/board?api_key=wrong" }),
      KEY,
    );
    expect(outcome.kind === "respond" && outcome.response.status).toBe(401);
  });
});
