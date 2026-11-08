import { afterEach, expect, it, vi } from "vitest";
import { pageClientData } from "./page-backend.js";
afterEach(() => vi.unstubAllEnvs());
it("keeps a read-only in-memory Node server on HTTP capabilities instead of an export seed", () => {
  vi.stubEnv("DATABASE_URL", "file::memory:");
  vi.stubEnv("KOZANE_READONLY", "1");
  const data = pageClientData(false, { namespaces: [] });
  expect(data.staticClientData).toBeUndefined();
  expect(data.clientCapabilities).toMatchObject({
    writable: false,
    persistent: false,
    taskspaces: true,
    externalWrites: true,
  });
});
it("keeps static export selection independent of mutable Node configuration", () => {
  vi.stubEnv("KOZANE_READONLY", "0");
  const data = pageClientData(true, { namespaces: [] });
  expect(data.clientCapabilities).toBeUndefined();
  expect(data.staticClientData).toEqual({ namespaces: [] });
});
it("explains temporary file-backed server memory without advertising browser recovery", () => {
  vi.stubEnv("DATABASE_URL", "file:/tmp/kozane-memory-example/kozane.db");
  vi.stubEnv("KOZANE_MEMORY_MODE", "1");
  vi.stubEnv("KOZANE_READONLY", "0");
  const data = pageClientData(false, { namespaces: [] });
  expect(data.clientCapabilities).toMatchObject({ writable: true, persistent: false });
  expect(data.clientLifetimeNotice).toBe(
    "Database changes last for this server process and are lost when it stops.",
  );
  expect(data.staticClientData).toBeUndefined();
  expect(JSON.stringify(data)).not.toMatch(/sessionStorage|reload recovery/);
});
it("does not attach server lifetime wording to static exports", () => {
  vi.stubEnv("KOZANE_MEMORY_MODE", "1");
  const data = pageClientData(true, { namespaces: [] });
  expect(data.clientLifetimeNotice).toBeUndefined();
});
