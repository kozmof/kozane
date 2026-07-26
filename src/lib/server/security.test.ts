import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_FAILURE_LIMIT,
  AUTH_FAILURE_MAX_CLIENTS,
  _resetAuthFailuresForTest,
  applySecurityHeaders,
  clearAuthFailures,
  isBrowserNavigation,
  isLoopbackHost,
  recordAuthFailure,
  remoteBindingRequiresApiKey,
  remoteBindingRequiresTls,
} from "./security";

describe("server security", () => {
  beforeEach(() => _resetAuthFailuresForTest());

  it("recognizes loopback hosts, including hosts with ports", () => {
    expect(isLoopbackHost("localhost:5173")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("[::1]:5173")).toBe(true);
    expect(remoteBindingRequiresApiKey("::1")).toBe(false);
    expect(remoteBindingRequiresTls("http:", "::1")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("2001:db8::1")).toBe(false);
    expect(remoteBindingRequiresApiKey("example.test")).toBe(true);
    expect(remoteBindingRequiresTls("http:", "0.0.0.0")).toBe(true);
    expect(remoteBindingRequiresTls("https:", "0.0.0.0")).toBe(false);
    expect(remoteBindingRequiresTls("http:", "127.0.0.1")).toBe(false);
  });

  it("treats document loads as browser navigations but not API/fetch requests", () => {
    const req = (method: string, headers: HeadersInit) =>
      new Request("http://localhost/", { method, headers });
    expect(isBrowserNavigation(req("GET", { "sec-fetch-mode": "navigate" }))).toBe(true);
    expect(isBrowserNavigation(req("GET", { accept: "text/html,application/xhtml+xml" }))).toBe(
      true,
    );
    expect(isBrowserNavigation(req("GET", { accept: "application/json" }))).toBe(false);
    expect(isBrowserNavigation(req("POST", { "sec-fetch-mode": "cors" }))).toBe(false);
    expect(isBrowserNavigation(req("GET", {}))).toBe(false);
  });

  it("throttles repeated authentication failures and permits reset", () => {
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      expect(recordAuthFailure("client", 1_000)).toBeNull();
    }
    expect(recordAuthFailure("client", 1_000)).toBeGreaterThan(0);
    clearAuthFailures("client");
    expect(recordAuthFailure("client", 1_000)).toBeNull();
  });

  it("bounds authentication failure tracking", () => {
    for (let i = 0; i < AUTH_FAILURE_MAX_CLIENTS + 10; i += 1) {
      recordAuthFailure(`client-${i}`, 1_000);
    }
    expect(recordAuthFailure("client-0", 1_000)).toBeNull();
  });

  it("adds browser hardening headers without losing the response", async () => {
    const response = applySecurityHeaders(new Response("ok", { status: 201 }));
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
