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
  const p = parsed as Record<string, unknown>;
  if (typeof parsed !== "object" || parsed === null || typeof p.name !== "string") {
    throw new Error(`Invalid Kozane config at ${configPath}`);
  }
  const server = p.server as Record<string, unknown> | undefined;
  if (typeof server !== "object" || server === null ||
      typeof server.host !== "string" || typeof server.port !== "number") {
    throw new Error(`Invalid server config at ${configPath}`);
  }
  const wc = p.workingCopy as Record<string, unknown> | undefined;
  if (typeof wc !== "object" || wc === null ||
      typeof wc.defaultDir !== "string" || !Array.isArray(wc.searchRoots)) {
    throw new Error(`Invalid workingCopy config at ${configPath}`);
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
