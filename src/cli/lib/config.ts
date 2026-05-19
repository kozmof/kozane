import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CANVAS_W, CANVAS_H } from "../../lib/constants.js";

export type UiConfig = {
  defaultFontSize: number;
  defaultFontFamily: string;
  defaultCardWidth: number;
  defaultZoom: number;
  leftPanelWidth: number;
  rightPanelWidth: number;
  defaultShowFooter: boolean;
  defaultShowSidePanel: boolean;
  canvasWidth: number;
  canvasHeight: number;
};

export const DEFAULT_UI_CONFIG: UiConfig = {
  defaultFontSize: 11.5,
  defaultFontFamily: "monospace",
  defaultCardWidth: 240,
  defaultZoom: 1,
  leftPanelWidth: 216,
  rightPanelWidth: 232,
  defaultShowFooter: false,
  defaultShowSidePanel: false,
  canvasWidth: CANVAS_W,
  canvasHeight: CANVAS_H,
};

export type WorkspaceConfig = {
  name: string;
  server: {
    host: string;
    port: number;
  };
  workingCopy: {
    defaultDir: string;
    searchRoots: string[];
  };
  ui?: Partial<UiConfig>;
};

export const KOZANE_DIR = ".kozane";
export const CONFIG_FILE = "config.json";
export const DB_FILE = "kozane.db";
export const MIGRATION_DIR = "drizzle";

export function defaultConfig(name: string): WorkspaceConfig {
  return {
    name,
    server: { host: "127.0.0.1", port: 5173 },
    workingCopy: {
      defaultDir: ".",
      searchRoots: ["."],
    },
    ui: { ...DEFAULT_UI_CONFIG },
  };
}

export function readConfig(projectRoot: string): WorkspaceConfig {
  const configPath = join(projectRoot, KOZANE_DIR, CONFIG_FILE);
  const raw = readFileSync(configPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid Kozane config at ${configPath}`);
  }
  const p = parsed as Record<string, unknown>;

  if (typeof p.name !== "string") throw new Error(`Invalid Kozane config: name must be a string`);

  const server = p.server;
  if (typeof server !== "object" || server === null || Array.isArray(server)) {
    throw new Error(`Invalid Kozane config: server must be an object`);
  }
  const s = server as Record<string, unknown>;
  if (typeof s.host !== "string") throw new Error(`Invalid Kozane config: server.host must be a string`);
  if (typeof s.port !== "number") throw new Error(`Invalid Kozane config: server.port must be a number`);

  const wc = p.workingCopy;
  if (typeof wc !== "object" || wc === null || Array.isArray(wc)) {
    throw new Error(`Invalid Kozane config: workingCopy must be an object`);
  }
  const w = wc as Record<string, unknown>;
  if (typeof w.defaultDir !== "string") throw new Error(`Invalid Kozane config: workingCopy.defaultDir must be a string`);
  if (!Array.isArray(w.searchRoots) || w.searchRoots.some((r) => typeof r !== "string")) {
    throw new Error(`Invalid Kozane config: workingCopy.searchRoots must be an array of strings`);
  }

  const ui = p.ui;
  if (ui !== undefined) {
    if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
      throw new Error(`Invalid Kozane config: ui must be an object`);
    }
    const u = ui as Record<string, unknown>;
    const numFields = ["defaultFontSize", "defaultCardWidth", "defaultZoom", "leftPanelWidth", "rightPanelWidth", "canvasWidth", "canvasHeight"] as const;
    const boolFields = ["defaultShowFooter", "defaultShowSidePanel"] as const;
    const strFields = ["defaultFontFamily"] as const;
    for (const f of numFields) {
      if (u[f] !== undefined && typeof u[f] !== "number") throw new Error(`Invalid Kozane config: ui.${f} must be a number`);
    }
    for (const f of boolFields) {
      if (u[f] !== undefined && typeof u[f] !== "boolean") throw new Error(`Invalid Kozane config: ui.${f} must be a boolean`);
    }
    for (const f of strFields) {
      if (u[f] !== undefined && typeof u[f] !== "string") throw new Error(`Invalid Kozane config: ui.${f} must be a string`);
    }
  }

  return parsed as WorkspaceConfig;
}

export function writeConfig(projectRoot: string, config: WorkspaceConfig): void {
  const configPath = join(projectRoot, KOZANE_DIR, CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function dbPath(projectRoot: string): string {
  return join(projectRoot, KOZANE_DIR, DB_FILE);
}

export function dbUrl(projectRoot: string): string {
  return `file:${dbPath(projectRoot)}`;
}
