import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_CONFIG,
  UI_KNOWN_KEYS,
  parseUiOverrides,
  validateUiOverrides,
} from "./ui-config.js";

describe("parseUiOverrides", () => {
  it("returns an empty object for a missing ui block", () => {
    expect(parseUiOverrides(undefined, { strict: true })).toEqual({});
    expect(parseUiOverrides(undefined, { strict: false })).toEqual({});
  });

  it("keeps valid values of every field kind", () => {
    const ui = {
      defaultFontSize: 14,
      defaultShowFooter: true,
      defaultFontFamily: "serif",
      newCardPlacement: "grid",
    };
    const expected = {
      defaultFontSize: 14,
      defaultShowFooter: true,
      defaultFontFamily: "serif",
      newCardPlacement: "grid",
    };
    expect(parseUiOverrides(ui, { strict: true })).toEqual(expected);
    expect(parseUiOverrides(ui, { strict: false })).toEqual(expected);
  });

  it("ignores unknown keys", () => {
    expect(parseUiOverrides({ nope: 1 }, { strict: true })).toEqual({});
  });

  // Each case is rejected in strict mode and dropped in lenient mode — the two modes
  // must never disagree about which values are valid, only about the reaction.
  const invalid: [string, Record<string, unknown>, string][] = [
    ["a non-numeric number field", { defaultFontSize: "big" }, "ui.defaultFontSize must be a"],
    ["an out-of-range number", { defaultFontSize: 9_000 }, "ui.defaultFontSize must be between"],
    ["NaN", { defaultFontSize: Number.NaN }, "ui.defaultFontSize must be a"],
    ["a non-boolean boolean field", { defaultShowFooter: "yes" }, "ui.defaultShowFooter must be a"],
    ["a non-string string field", { defaultFontFamily: 12 }, "ui.defaultFontFamily must be a"],
    ["an unknown placement", { newCardPlacement: "spiral" }, "ui.newCardPlacement must be"],
  ];

  for (const [label, ui, message] of invalid) {
    it(`rejects ${label} in strict mode and drops it in lenient mode`, () => {
      expect(() => parseUiOverrides(ui, { strict: true })).toThrow(message);
      expect(parseUiOverrides(ui, { strict: false })).toEqual({});
    });
  }

  it("treats a non-object ui block the same way in both modes", () => {
    expect(() => parseUiOverrides([], { strict: true })).toThrow("ui must be an object");
    expect(parseUiOverrides([], { strict: false })).toEqual({});
    expect(parseUiOverrides(null, { strict: false })).toEqual({});
  });
});

describe("validateUiOverrides", () => {
  it("collects every problem instead of stopping at the first", () => {
    const { issues } = validateUiOverrides({
      defaultFontSize: "big",
      defaultShowFooter: "yes",
      defaultFontFamily: 12,
      newCardPlacement: "spiral",
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      "ui.defaultFontSize",
      "ui.defaultShowFooter",
      "ui.defaultFontFamily",
      "ui.newCardPlacement",
    ]);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });

  it("keeps the valid fields alongside the issues", () => {
    const { value, issues } = validateUiOverrides({ defaultFontSize: 14, defaultZoom: 42 });
    expect(value).toEqual({ defaultFontSize: 14 });
    expect(issues).toEqual([
      {
        path: "ui.defaultZoom",
        severity: "error",
        message: "ui.defaultZoom must be between 0.1 and 10",
        found: 42,
      },
    ]);
  });

  it("reports the rejected value so a doctor can show it", () => {
    const [issue] = validateUiOverrides({ defaultFontFamily: 12 }).issues;
    expect(issue.found).toBe(12);
  });
});

describe("UI_KNOWN_KEYS", () => {
  it("covers every default, so unknown-key checks stay in step with the type", () => {
    expect(UI_KNOWN_KEYS).toEqual(Object.keys(DEFAULT_UI_CONFIG));
    expect(UI_KNOWN_KEYS).toContain("newCardPlacement");
  });
});
