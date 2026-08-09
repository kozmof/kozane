import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeServerProcess } from "../../lib/server/runtime-state.js";
import { type UiConfig, DEFAULT_UI_CONFIG, parseUiOverrides } from "../../lib/ui-config.js";

export type { UiConfig };
export { DEFAULT_UI_CONFIG };

export type WorkspaceConfig = {
  name: string;
  server: {
    host: string;
    port: number;
  };
  taskspace: {
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
    taskspace: {
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
  if (typeof s.host !== "string")
    throw new Error(`Invalid Kozane config: server.host must be a string`);
  if (typeof s.port !== "number")
    throw new Error(`Invalid Kozane config: server.port must be a number`);

  const taskspace = p.taskspace;
  if (typeof taskspace !== "object" || taskspace === null || Array.isArray(taskspace)) {
    throw new Error(`Invalid Kozane config: taskspace must be an object`);
  }
  const w = taskspace as Record<string, unknown>;
  if (typeof w.defaultDir !== "string")
    throw new Error(`Invalid Kozane config: taskspace.defaultDir must be a string`);
  if (!Array.isArray(w.searchRoots) || w.searchRoots.some((r) => typeof r !== "string")) {
    throw new Error(`Invalid Kozane config: taskspace.searchRoots must be an array of strings`);
  }

  // Strict: the CLI is reading a file the user just edited, so a bad `ui` value is
  // reported rather than silently dropped. The server uses the lenient mode of the
  // same parser (db/internal/config.ts) so the two can never disagree on validity.
  const parsedUi: Partial<UiConfig> | undefined =
    p.ui === undefined ? undefined : parseUiOverrides(p.ui, { strict: true });

  return {
    name: p.name as string,
    server: { host: s.host as string, port: s.port as number },
    taskspace: {
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

/** Database used by interactive CLI commands for the active workspace session. */
export function commandDbUrl(projectRoot: string): string {
  const state = activeServerProcess(projectRoot);
  if (state?.memory && state.databaseUrl) return state.databaseUrl;
  return dbUrl(projectRoot);
}
