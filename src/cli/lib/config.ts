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

  type NumRange = [lo: number, hi: number];
  const UI_NUM_RANGES: Record<string, NumRange> = {
    defaultFontSize:   [4,   128],
    defaultCardWidth:  [40,  1200],
    defaultZoom:       [0.1, 10],
    leftPanelWidth:    [80,  800],
    rightPanelWidth:   [80,  800],
    canvasWidth:       [400, 20000],
    canvasHeight:      [400, 20000],
  };
  const UI_BOOL_FIELDS = ["defaultShowFooter", "defaultShowSidePanel"] as const;
  const UI_STR_FIELDS  = ["defaultFontFamily"] as const;

  let parsedUi: Partial<UiConfig> | undefined;
  const ui = p.ui;
  if (ui !== undefined) {
    if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
      throw new Error(`Invalid Kozane config: ui must be an object`);
    }
    const u = ui as Record<string, unknown>;
    parsedUi = {};

    for (const [f, [lo, hi]] of Object.entries(UI_NUM_RANGES)) {
      if (u[f] === undefined) continue;
      if (typeof u[f] !== "number") throw new Error(`Invalid Kozane config: ui.${f} must be a number`);
      if ((u[f] as number) < lo || (u[f] as number) > hi)
        throw new Error(`Invalid Kozane config: ui.${f} must be between ${lo} and ${hi}`);
      (parsedUi as Record<string, unknown>)[f] = u[f];
    }
    for (const f of UI_BOOL_FIELDS) {
      if (u[f] === undefined) continue;
      if (typeof u[f] !== "boolean") throw new Error(`Invalid Kozane config: ui.${f} must be a boolean`);
      parsedUi[f] = u[f] as boolean;
    }
    for (const f of UI_STR_FIELDS) {
      if (u[f] === undefined) continue;
      if (typeof u[f] !== "string") throw new Error(`Invalid Kozane config: ui.${f} must be a string`);
      parsedUi[f] = u[f] as string;
    }
  }

  return {
    name: p.name as string,
    server: { host: s.host as string, port: s.port as number },
    workingCopy: {
      defaultDir: w.defaultDir as string,
      searchRoots: w.searchRoots as string[],
    },
    ...(parsedUi !== undefined && { ui: parsedUi }),
  };
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
