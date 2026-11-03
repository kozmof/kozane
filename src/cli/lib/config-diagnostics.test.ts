import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_KNOWN_KEYS } from "../../lib/ui-config.js";
import { CONFIG_FILE, KOZANE_DIR } from "./config.js";
import { diagnoseConfig } from "./config-diagnostics.js";
import { suggestKey } from "./config-schema.js";

let root: string;

const validConfig = {
  name: "demo",
  server: { host: "127.0.0.1", port: 17173 },
  taskspace: { defaultDir: ".", searchRoots: ["."] },
};

function writeRawConfig(raw: unknown): void {
  mkdirSync(join(root, KOZANE_DIR), { recursive: true });
  const body = typeof raw === "string" ? raw : JSON.stringify(raw);
  writeFileSync(join(root, KOZANE_DIR, CONFIG_FILE), body, "utf-8");
}

function messages(raw: unknown): string[] {
  writeRawConfig(raw);
  return diagnoseConfig(root).issues.map((issue) => issue.message);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-config-doctor-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("diagnoseConfig", () => {
  it("reports nothing for a valid config", () => {
    writeRawConfig(validConfig);
    const report = diagnoseConfig(root);
    expect(report.issues).toEqual([]);
    expect(report.path).toBe(join(root, KOZANE_DIR, CONFIG_FILE));
  });

  it("reports a missing config file", () => {
    expect(diagnoseConfig(root).issues).toEqual([
      { path: "", severity: "error", message: `config.json is missing — run "kozane init"` },
    ]);
  });

  it("reports a JSON syntax error", () => {
    writeRawConfig("{ not json");
    const [issue] = diagnoseConfig(root).issues;
    expect(issue.severity).toBe("error");
    expect(issue.message).toMatch(/^config\.json is not valid JSON: /);
  });

  it("reports a config that is not a JSON object", () => {
    expect(messages([1, 2])).toEqual(["config must be a JSON object"]);
  });

  describe("missing keys", () => {
    it("reports missing required keys and sections", () => {
      expect(messages({ server: { port: 17173 } })).toEqual([
        "name is missing",
        "taskspace is missing",
      ]);
    });

    it("reports a missing key of a required section", () => {
      expect(messages({ name: "demo", taskspace: { defaultDir: "." } })).toEqual([
        "taskspace.searchRoots is missing",
      ]);
    });

    // The server falls back to the default too, so both put new taskspaces in the same place.
    it("accepts a taskspace section without defaultDir", () => {
      expect(messages({ name: "demo", taskspace: { searchRoots: ["."] } })).toEqual([]);
    });

    it("treats an omitted server section as a note, not a problem", () => {
      writeRawConfig({ name: "demo", taskspace: validConfig.taskspace });
      const report = diagnoseConfig(root);
      expect(report.issues).toEqual([]);
      expect(report.notes[0]).toEqual({
        message: "server: 2 of 2 keys not set — using defaults",
        details: [`host: "127.0.0.1"`, "port: 17173"],
      });
    });

    it("names every unset key and the default value standing in for it", () => {
      writeRawConfig({ ...validConfig, ui: { defaultFontSize: 14 } });
      const [note] = diagnoseConfig(root).notes;
      expect(note.message).toBe(
        `ui: ${UI_KNOWN_KEYS.length - 1} of ${UI_KNOWN_KEYS.length} keys not set — using defaults`,
      );
      expect(note.details).toHaveLength(UI_KNOWN_KEYS.length - 1);
      expect(note.details.some((detail) => detail.startsWith("defaultFontSize:"))).toBe(false);
      expect(note.details).toContain(`defaultFontFamily: "monospace"`);
      expect(note.details).toContain("zoomStep: 0.05");
      expect(note.details).toContain("defaultShowFooter: false");
      expect(note.details).toContain(`newCardPlacement: "vertical-list"`);
    });

    it("reports every ui key when the block is omitted entirely", () => {
      writeRawConfig(validConfig);
      const [note] = diagnoseConfig(root).notes;
      expect(note.message).toBe(
        `ui: ${UI_KNOWN_KEYS.length} of ${UI_KNOWN_KEYS.length} keys not set — using defaults`,
      );
      expect(note.details).toHaveLength(UI_KNOWN_KEYS.length);
    });

    it("skips the note for a section that is malformed rather than unset", () => {
      writeRawConfig({ ...validConfig, ui: [] });
      const report = diagnoseConfig(root);
      expect(report.issues.map((issue) => issue.message)).toEqual(["ui must be an object"]);
      expect(report.notes).toEqual([]);
    });
  });

  describe("irregular keys", () => {
    it("warns about unknown keys at every level", () => {
      writeRawConfig({
        ...validConfig,
        colour: "red",
        server: { ...validConfig.server, protocol: "https" },
        taskspace: { ...validConfig.taskspace, roots: [] },
        ui: { fontSize: 14 },
      });
      const { issues } = diagnoseConfig(root);

      expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
      expect(issues.map((issue) => issue.path)).toEqual([
        "colour",
        "server.protocol",
        "taskspace.roots",
        "ui.fontSize",
      ]);
    });

    it("suggests the key a near miss was probably meant to be", () => {
      expect(messages({ ...validConfig, ui: { defaultFontSze: 14 } })).toEqual([
        `ui.defaultFontSze is not a known key — did you mean "defaultFontSize"?`,
      ]);
    });

    it("ignores a setting Kozane no longer reads", () => {
      expect(messages({ ...validConfig, ui: { rightPanelWidth: 232 } })).toEqual([]);
    });

    it("stays quiet about a suggestion when nothing is close", () => {
      expect(messages({ ...validConfig, ui: { wallpaper: "blue" } })).toEqual([
        "ui.wallpaper is not a known key",
      ]);
    });
  });

  describe("invalid values", () => {
    it("reports every problem instead of stopping at the first", () => {
      expect(
        messages({
          name: 7,
          server: { host: 1, port: 70000 },
          taskspace: { defaultDir: ".", namespaceDirs: "yes", searchRoots: ["a", 2] },
          ui: { defaultZoom: 42, defaultShowFooter: "yes", newCardPlacement: "spiral" },
        }),
      ).toEqual([
        "name must be a string",
        "server.host must be a string",
        "server.port must be between 0 and 65535",
        "taskspace.namespaceDirs must be true or false",
        "taskspace.searchRoots must be an array of strings",
        "ui.defaultZoom must be between 0.1 and 10",
        "ui.defaultShowFooter must be a boolean",
        `ui.newCardPlacement must be "grid" or "vertical-list"`,
      ]);
    });

    it("checks taskspace.namespacePaths keys and paths", () => {
      const withPaths = (namespacePaths: unknown) =>
        messages({ ...validConfig, taskspace: { ...validConfig.taskspace, namespacePaths } });
      expect(withPaths({ aa414b7: "work/acme" })).toEqual([]);
      expect(withPaths(["work"])).toEqual([
        "taskspace.namespacePaths must be an object of namespace IDs to directories",
      ]);
      expect(withPaths({ "My namespace": "work" })).toEqual([
        'taskspace.namespacePaths key "My namespace" must be a namespace ID as kozane namespace list shows it (7 to 12 characters) or the full ID',
      ]);
      // Hex letters alone, but too short to be a short ID.
      expect(withPaths({ cafe: "work" })).toEqual([
        'taskspace.namespacePaths key "cafe" must be a namespace ID as kozane namespace list shows it (7 to 12 characters) or the full ID',
      ]);
      // Longer than a short ID but not a full ID, such as the start of a UUID: matches nothing.
      expect(withPaths({ "019a7f3c-1b2d-7": "work" })).toEqual([
        'taskspace.namespacePaths key "019a7f3c-1b2d-7" must be a namespace ID as kozane namespace list shows it (7 to 12 characters) or the full ID',
      ]);
      expect(withPaths({ aa414b7c9d0e: "work" })).toEqual([]);
      expect(withPaths({ "019a7f3c-1b2d-7e4f-8a9b-0c1d2e3f4a5b": "work" })).toEqual([]);
      expect(withPaths({ aa414b7: " " })).toEqual([
        "taskspace.namespacePaths.aa414b7 must be a nonempty directory path",
      ]);
    });

    it("reports a section that is not an object", () => {
      expect(messages({ ...validConfig, taskspace: [] })).toEqual(["taskspace must be an object"]);
    });

    it("keeps the rejected value for display", () => {
      writeRawConfig({ ...validConfig, server: { port: 70000 } });
      expect(diagnoseConfig(root).issues[0]).toMatchObject({
        path: "server.port",
        severity: "error",
        found: 70000,
      });
    });

    it("lists errors before warnings", () => {
      writeRawConfig({ ...validConfig, colour: "red", server: { port: "17173" } });
      expect(diagnoseConfig(root).issues.map((issue) => issue.severity)).toEqual([
        "error",
        "warning",
      ]);
    });
  });
});

describe("suggestKey", () => {
  const known = ["defaultFontSize", "defaultCardWidth", "canvasWidth"];

  it("matches a transposition, a dropped letter, and a case difference", () => {
    expect(suggestKey("defaultFontSzie", known)).toBe("defaultFontSize");
    expect(suggestKey("defaultFontSze", known)).toBe("defaultFontSize");
    expect(suggestKey("defaultfontsize", known)).toBe("defaultFontSize");
  });

  it("returns null when nothing is close enough", () => {
    expect(suggestKey("wallpaper", known)).toBeNull();
  });

  it("holds short keys to a tighter threshold", () => {
    expect(suggestKey("port", ["host", "port"])).toBe("port");
    expect(suggestKey("prt", ["host", "port"])).toBe("port");
    expect(suggestKey("zzzz", ["host", "port"])).toBeNull();
  });

  it("picks the closest of several candidates", () => {
    expect(suggestKey("canvasWidht", known)).toBe("canvasWidth");
  });
});
