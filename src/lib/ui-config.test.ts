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
    [
      "a shortcut on a key that moves between warps",
      { setWarpShortcut: "ArrowRight" },
      `ui.setWarpShortcut must not be "ArrowRight"`,
    ],
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

describe("shortcut bindings", () => {
  const issuesFor = (ui: Record<string, unknown>) => validateUiOverrides(ui).issues;

  it("warns when two shortcuts are bound to the same key", () => {
    const issues = issuesFor({ setWarpShortcut: "z", removeWarpShortcut: "z" });

    expect(issues).toEqual([
      {
        path: "ui.setWarpShortcut",
        severity: "warning",
        message: `ui.setWarpShortcut, ui.removeWarpShortcut are bound to the same key "z"`,
        found: "z",
      },
      {
        path: "ui.removeWarpShortcut",
        severity: "warning",
        message: `ui.setWarpShortcut, ui.removeWarpShortcut are bound to the same key "z"`,
        found: "z",
      },
    ]);
  });

  it("sees a collision with a shortcut left at its default", () => {
    // `f` is toggleFootersShortcut out of the box: the config only has to name one side.
    const issues = issuesFor({ setWarpShortcut: DEFAULT_UI_CONFIG.toggleFootersShortcut });

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("ui.setWarpShortcut");
    expect(issues[0].message).toContain("ui.toggleFootersShortcut");
  });

  it("keeps a colliding binding, since both actions still work", () => {
    const { value } = validateUiOverrides({ setWarpShortcut: "z", removeWarpShortcut: "z" });

    expect(value).toEqual({ setWarpShortcut: "z", removeWarpShortcut: "z" });
    expect(
      parseUiOverrides({ setWarpShortcut: "z", removeWarpShortcut: "z" }, { strict: true }),
    ).toEqual({ setWarpShortcut: "z", removeWarpShortcut: "z" });
  });

  it("says nothing about the defaults on their own", () => {
    expect(issuesFor({})).toEqual([]);
    expect(issuesFor({ defaultFontSize: 14 })).toEqual([]);
  });

  it("checks the resize shortcut like every other binding", () => {
    // Added to UI_SHORTCUT_FIELDS rather than checked on its own, which is what earns it
    // the arrow-key refusal and the collision warning without any code of its own.
    expect(issuesFor({ resizeCardShortcut: "ArrowLeft" })).toEqual([
      {
        path: "ui.resizeCardShortcut",
        severity: "error",
        message: `ui.resizeCardShortcut must not be "ArrowLeft", which moves between warps`,
        found: "ArrowLeft",
      },
    ]);
    expect(issuesFor({ resizeCardShortcut: DEFAULT_UI_CONFIG.glueCardsShortcut })).toHaveLength(1);
    expect(parseUiOverrides({ resizeCardShortcut: "k" }, { strict: true })).toEqual({
      resizeCardShortcut: "k",
    });
  });

  it("ignores empty bindings, which match no key to collide over", () => {
    expect(issuesFor({ setWarpShortcut: "", removeWarpShortcut: "" })).toEqual([]);
  });

  it("drops a shortcut bound to an arrow key so its default stands", () => {
    const { value, issues } = validateUiOverrides({
      setWarpShortcut: "ArrowUp",
      removeWarpShortcut: "z",
    });

    expect(value).toEqual({ removeWarpShortcut: "z" });
    expect(issues).toEqual([
      {
        path: "ui.setWarpShortcut",
        severity: "error",
        message: `ui.setWarpShortcut must not be "ArrowUp", which moves between warps`,
        found: "ArrowUp",
      },
    ]);
  });
});

describe("UI_KNOWN_KEYS", () => {
  it("covers every default, so unknown-key checks stay in step with the type", () => {
    expect(UI_KNOWN_KEYS).toEqual(Object.keys(DEFAULT_UI_CONFIG));
    expect(UI_KNOWN_KEYS).toContain("newCardPlacement");
  });
});
