import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetWorkspaceRootForTest,
  getTaskspaceDefaultDir,
  getWorkspaceUiConfig,
} from "./config.js";
import { DEFAULT_UI_CONFIG } from "../../lib/ui-config.js";

let root: string;
const previousRoot = process.env.KOZANE_WORKSPACE_ROOT;

function writeConfig(value: unknown): void {
  writeFileSync(join(root, ".kozane", "config.json"), JSON.stringify(value, null, 2) + "\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-config-"));
  mkdirSync(join(root, ".kozane"));
  writeConfig({ name: "w" });
  process.env.KOZANE_WORKSPACE_ROOT = root;
  _resetWorkspaceRootForTest();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.KOZANE_WORKSPACE_ROOT;
  else process.env.KOZANE_WORKSPACE_ROOT = previousRoot;
  _resetWorkspaceRootForTest();
  rmSync(root, { recursive: true, force: true });
});

describe("getWorkspaceUiConfig", () => {
  it("falls back to the defaults when the file sets no ui block", () => {
    expect(getWorkspaceUiConfig()).toEqual(DEFAULT_UI_CONFIG);
  });

  it("applies overrides over the defaults", () => {
    writeConfig({ name: "w", ui: { defaultZoom: 1.5 } });
    expect(getWorkspaceUiConfig()).toMatchObject({
      defaultZoom: 1.5,
      defaultCardWidth: DEFAULT_UI_CONFIG.defaultCardWidth,
    });
  });

  it("picks up an edit to the config file without a restart", () => {
    writeConfig({ name: "w", ui: { defaultZoom: 1.5 } });
    expect(getWorkspaceUiConfig().defaultZoom).toBe(1.5);

    // The config is a file the user is invited to hand-edit (`kozane doctor config` reads
    // it back to them), so a setting that appeared to do nothing until the server was
    // restarted would look like a setting that does not work.
    writeConfig({ name: "w", ui: { defaultZoom: 0.75 } });

    expect(getWorkspaceUiConfig().defaultZoom).toBe(0.75);
  });

  it("returns to the defaults when the overrides are removed again", () => {
    writeConfig({ name: "w", ui: { defaultZoom: 1.5 } });
    expect(getWorkspaceUiConfig().defaultZoom).toBe(1.5);

    writeConfig({ name: "w" });

    expect(getWorkspaceUiConfig().defaultZoom).toBe(DEFAULT_UI_CONFIG.defaultZoom);
  });

  it("keeps the defaults for a value it cannot use", () => {
    writeConfig({ name: "w", ui: { defaultZoom: "wide" } });
    expect(getWorkspaceUiConfig().defaultZoom).toBe(DEFAULT_UI_CONFIG.defaultZoom);
  });
});

describe("getTaskspaceDefaultDir", () => {
  it("defaults to the workspace root", () => {
    expect(getTaskspaceDefaultDir(root)).toBe(".");
  });

  it("reads the configured directory, and re-reads it after an edit", () => {
    writeConfig({ name: "w", taskspace: { defaultDir: "spaces" } });
    expect(getTaskspaceDefaultDir(root)).toBe("spaces");

    writeConfig({ name: "w", taskspace: { defaultDir: "work" } });

    expect(getTaskspaceDefaultDir(root)).toBe("work");
  });
});
