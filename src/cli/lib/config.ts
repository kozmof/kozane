import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type UiConfig = {
  defaultFontSize: number;
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
  defaultCardWidth: 240,
  defaultZoom: 1,
  leftPanelWidth: 216,
  rightPanelWidth: 232,
  defaultShowFooter: true,
  defaultShowSidePanel: true,
  canvasWidth: 2800,
  canvasHeight: 2000,
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
      defaultDir: ".kozane/working-copies",
      searchRoots: [".", ".kozane/working-copies"],
    },
  };
}

export function readConfig(projectRoot: string): WorkspaceConfig {
  const configPath = join(projectRoot, KOZANE_DIR, CONFIG_FILE);
  const raw = readFileSync(configPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).name !== "string" ||
    typeof (parsed as Record<string, unknown>).server !== "object" ||
    typeof (parsed as Record<string, unknown>).workingCopy !== "object"
  ) {
    throw new Error(`Invalid Kozane config at ${configPath}`);
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
