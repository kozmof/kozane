import { describe, expect, it } from "vitest";
import type { ConfigSnapshot } from "../cli/lib/config-editor/handler.js";
import type { FieldSpec } from "../cli/lib/config-editor/fields.js";
import {
  currentValue,
  describeValue,
  matchesFilter,
  numberChange,
  parseListInput,
  usesDefault,
  withChange,
} from "./edit-state.js";

const zoom: FieldSpec = {
  path: "ui.defaultZoom",
  group: "View",
  label: "Default zoom",
  help: "Zoom level when a board opens.",
  kind: "number",
  defaultValue: 1,
  required: false,
};
const vim: FieldSpec = { ...zoom, path: "ui.editorVimMode", kind: "boolean", defaultValue: false };

function snapshotWith(values: Record<string, unknown>): ConfigSnapshot {
  return { path: "", signature: null, groups: [], fields: [zoom, vim], values, issues: [] };
}

describe("withChange", () => {
  const snapshot = snapshotWith({ "ui.defaultZoom": 1.5 });

  it("records a new value", () => {
    expect(withChange(snapshot, {}, zoom, 2)).toEqual({ "ui.defaultZoom": 2 });
  });

  it("drops the change when the value goes back to the file's", () => {
    const changed = withChange(snapshot, {}, zoom, 2);
    expect(withChange(snapshot, changed, zoom, 1.5)).toEqual({});
  });

  it("drops the change when an absent key is set to its default", () => {
    expect(withChange(snapshot, {}, vim, false)).toEqual({});
    expect(withChange(snapshot, {}, vim, true)).toEqual({ "ui.editorVimMode": true });
  });

  it("removes a key the file has, and forgets a removal of one it lacks", () => {
    expect(withChange(snapshot, {}, zoom, null)).toEqual({ "ui.defaultZoom": null });
    expect(withChange(snapshot, { "ui.editorVimMode": true }, vim, null)).toEqual({});
  });

  it("leaves the changes it was given alone", () => {
    const changes = {};
    withChange(snapshot, changes, zoom, 2);
    expect(changes).toEqual({});
  });
});

describe("currentValue and usesDefault", () => {
  const snapshot = snapshotWith({ "ui.defaultZoom": 1.5 });

  it("prefers a pending change, then the file, then the default", () => {
    expect(currentValue(snapshot, { "ui.defaultZoom": 3 }, zoom)).toBe(3);
    expect(currentValue(snapshot, {}, zoom)).toBe(1.5);
    expect(currentValue(snapshot, { "ui.defaultZoom": null }, zoom)).toBe(1);
    expect(currentValue(snapshot, {}, vim)).toBe(false);
  });

  it("knows when the default will apply", () => {
    expect(usesDefault(snapshot, {}, zoom)).toBe(false);
    expect(usesDefault(snapshot, { "ui.defaultZoom": null }, zoom)).toBe(true);
    expect(usesDefault(snapshot, {}, vim)).toBe(true);
    expect(usesDefault(snapshot, { "ui.editorVimMode": true }, vim)).toBe(false);
  });
});

describe("input helpers", () => {
  it("treats a blank number as using the default", () => {
    expect(numberChange(null)).toBeNull();
    expect(numberChange(Number.NaN)).toBeNull();
    expect(numberChange(0)).toBe(0);
  });

  it("splits a list into trimmed, non-blank lines", () => {
    expect(parseListInput(" a \n\n b\n")).toEqual(["a", "b"]);
  });

  it("describes values the way the page prints them", () => {
    expect(describeValue(vim, true)).toBe("on");
    expect(describeValue({ ...zoom, kind: "shortcut" }, " ")).toBe("Space");
    expect(describeValue({ ...zoom, kind: "shortcut" }, "")).toBe("(none)");
    expect(describeValue({ ...zoom, kind: "list" }, ["a", "b"])).toBe("a, b");
  });

  it("matches a filter against the label, path, and help", () => {
    expect(matchesFilter(zoom, "ZOOM")).toBe(true);
    expect(matchesFilter(zoom, "ui.default")).toBe(true);
    expect(matchesFilter(zoom, "board opens")).toBe(true);
    expect(matchesFilter(zoom, "warp")).toBe(false);
    expect(matchesFilter(zoom, "  ")).toBe(true);
  });
});
