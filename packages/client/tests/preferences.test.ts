import { expect, it, vi } from "vitest";
import { createMemoryPreferences, createSessionPreferences } from "../src/preferences.js";
it("retains legacy Node preference keys and tolerates unavailable storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const preferences = createSessionPreferences(() => storage);
  preferences.writeActiveLayer("ns", "layer");
  expect(values.get("kozane:active-layer:ns")).toBe("layer");
  expect(preferences.readActiveLayer("ns")).toBe("layer");
  preferences.writeActiveLayer("ns", null);
  expect(preferences.readActiveLayer("ns")).toBeNull();
  const blocked = createSessionPreferences(() => {
    throw new Error("blocked");
  });
  expect(blocked.readActiveLayer("ns")).toBeNull();
  expect(() => blocked.writeActiveLayer("ns", "layer")).not.toThrow();
  expect(createSessionPreferences(() => undefined).readActiveLayer("ns")).toBeNull();
});
it("preserves memory preferences across revisions and clears them only when the active generation changes", () => {
  const version = { generation: 0, revision: 0 };
  const preferences = createMemoryPreferences(() => version.generation);
  preferences.writeActiveLayer("one", "draft");
  preferences.writeActiveLayer("two", "notes");
  version.revision++;
  expect(preferences.readActiveLayer("one")).toBe("draft");
  expect(preferences.readActiveLayer("two")).toBe("notes");
  version.generation++;
  expect(preferences.generation).toBe(1);
  expect(preferences.readActiveLayer("one")).toBeNull();
  expect(preferences.readActiveLayer("two")).toBeNull();
  preferences.writeActiveLayer("one", "fresh");
  expect(preferences.readActiveLayer("one")).toBe("fresh");
  expect(createMemoryPreferences().readActiveLayer("one")).toBeNull();
});
it("never touches legacy storage even when access and deletion are denied", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const access = vi.fn(() => {
    throw new Error("storage denied");
  });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: access });
  try {
    let generation = 0;
    const preferences = createMemoryPreferences(() => generation);
    preferences.writeActiveLayer("ns", "draft");
    expect(preferences.readActiveLayer("ns")).toBe("draft");
    preferences.writeActiveLayer("ns", null);
    preferences.writeActiveLayer("ns", "draft");
    generation++;
    expect(preferences.readActiveLayer("ns")).toBeNull();
    expect(access).not.toHaveBeenCalled();
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
