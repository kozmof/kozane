import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_FAILURE_LIMIT,
  _resetAuthFailuresForTest,
  applySecurityHeaders,
  clearAuthFailures,
  isLoopbackHost,
  recordAuthFailure,
  remoteBindingRequiresApiKey,
} from "./security";

describe("server security", () => {
  beforeEach(() => _resetAuthFailuresForTest());

  it("recognizes loopback hosts, including hosts with ports", () => {
    expect(isLoopbackHost("localhost:5173")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]:5173")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(remoteBindingRequiresApiKey("example.test")).toBe(true);
  });

  it("throttles repeated authentication failures and permits reset", () => {
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      expect(recordAuthFailure("client", 1_000)).toBeNull();
    }
    expect(recordAuthFailure("client", 1_000)).toBeGreaterThan(0);
    clearAuthFailures("client");
    expect(recordAuthFailure("client", 1_000)).toBeNull();
  });

  it("adds browser hardening headers without losing the response", async () => {
    const response = applySecurityHeaders(new Response("ok", { status: 201 }));
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
