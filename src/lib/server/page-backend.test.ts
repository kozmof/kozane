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
