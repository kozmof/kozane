import { afterEach, beforeEach, expect, it, vi } from "vitest";
const config = vi.hoisted(() => ({
  getDBURL: vi.fn(() => "file:/workspace/notes.db"),
  getWorkspaceRoot: vi.fn<() => string | null>(() => null),
}));
const readApiKeyResult = vi.hoisted(() => vi.fn());
vi.mock("../../db/internal/config.js", () => config);
vi.mock("./api-key.js", () => ({ readApiKeyResult }));
import { httpClientCapabilities } from "./backend-capabilities.js";
beforeEach(() => {
  vi.stubEnv("KOZANE_READONLY", "0");
  vi.stubEnv("KOZANE_MEMORY_MODE", "0");
  config.getDBURL.mockReturnValue("file:/workspace/notes.db");
  config.getWorkspaceRoot.mockReturnValue(null);
  readApiKeyResult.mockReset().mockReturnValue({ ok: true, key: null });
});
afterEach(() => vi.unstubAllEnvs());
it.each([
  ["file:/workspace/notes.db", "0", "0", true, true],
  ["file:/workspace/notes.db", "0", "1", false, true],
  [":memory:", "0", "0", true, false],
  ["file::memory:?cache=shared", "0", "1", false, false],
  ["file:/tmp/kozane-memory-123/kozane.db", "1", "0", true, false],
  ["file:/tmp/kozane-memory-123/kozane.db", "1", "1", false, false],
] as const)(
  "resolves Node mode %s / memory=%s / readonly=%s",
  (url, memory, readonly, writable, persistent) => {
    config.getDBURL.mockReturnValue(url);
    vi.stubEnv("KOZANE_MEMORY_MODE", memory);
    vi.stubEnv("KOZANE_READONLY", readonly);
    const capabilities = httpClientCapabilities();
    expect(capabilities).toEqual({
      writable,
      persistent,
      taskspaces: true,
      externalWrites: true,
      auth: false,
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
  },
);
it("publishes only authentication availability, never credentials", () => {
  config.getWorkspaceRoot.mockReturnValue("/private/workspace");
  readApiKeyResult.mockReturnValue({
    ok: true,
    key: { apiKey: "private-fixture-value", createdAt: "2026-11-06T00:00:00Z" },
  });
  const capabilities = httpClientCapabilities();
  expect(capabilities.auth).toBe(true);
  expect(JSON.stringify(capabilities)).not.toContain("private");
  expect(readApiKeyResult).toHaveBeenCalledWith("/private/workspace");
});
it("does not advertise authentication when key resolution fails", () => {
  config.getWorkspaceRoot.mockReturnValue("/private/workspace");
  readApiKeyResult.mockReturnValue({ ok: false, message: "unreadable" });
  expect(httpClientCapabilities().auth).toBe(false);
});
