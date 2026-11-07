import { afterEach, expect, it, vi } from "vitest";
import { pageBackendData } from "./page-backend.js";
afterEach(() => vi.unstubAllEnvs());
it("keeps a read-only in-memory Node server on HTTP capabilities instead of an export seed", () => {
  vi.stubEnv("DATABASE_URL", "file::memory:");
  vi.stubEnv("KOZANE_READONLY", "1");
  const data = pageBackendData(false, { namespaces: [] });
  expect(data.staticBackendData).toBeUndefined();
  expect(data.backendCapabilities).toMatchObject({
    writable: false,
    persistent: false,
    taskspaces: true,
    externalWrites: true,
  });
});
it("keeps static export selection independent of mutable Node configuration", () => {
  vi.stubEnv("KOZANE_READONLY", "0");
  const data = pageBackendData(true, { namespaces: [] });
  expect(data.backendCapabilities).toBeUndefined();
  expect(data.staticBackendData).toEqual({ namespaces: [] });
});
it("explains temporary file-backed server memory without advertising browser recovery", () => {
  vi.stubEnv("DATABASE_URL", "file:/tmp/kozane-memory-example/kozane.db");
  vi.stubEnv("KOZANE_MEMORY_MODE", "1");
  vi.stubEnv("KOZANE_READONLY", "0");
  const data = pageBackendData(false, { namespaces: [] });
  expect(data.backendCapabilities).toMatchObject({ writable: true, persistent: false });
  expect(data.backendLifetimeNotice).toBe(
    "Database changes last for this server process and are lost when it stops.",
  );
  expect(data.staticBackendData).toBeUndefined();
  expect(JSON.stringify(data)).not.toMatch(/sessionStorage|reload recovery/);
});
it("does not attach server lifetime wording to static exports", () => {
  vi.stubEnv("KOZANE_MEMORY_MODE", "1");
  const data = pageBackendData(true, { namespaces: [] });
  expect(data.backendLifetimeNotice).toBeUndefined();
});
