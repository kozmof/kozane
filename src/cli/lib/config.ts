import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ProjectConfig = {
  name: string;
  server: {
    host: string;
    port: number;
  };
  workingCopy: {
    defaultDir: string;
    searchRoots: string[];
  };
};

export const KOZANE_DIR = ".kozane";
export const CONFIG_FILE = "config.json";
export const DB_FILE = "kozane.db";
export const MIGRATION_DIR = "drizzle";

export function defaultConfig(name: string): ProjectConfig {
  return {
    name,
    server: { host: "127.0.0.1", port: 5173 },
    workingCopy: {
      defaultDir: ".kozane/working-copies",
      searchRoots: [".", ".kozane/working-copies"],
    },
  };
}

export function readConfig(projectRoot: string): ProjectConfig {
  const configPath = join(projectRoot, KOZANE_DIR, CONFIG_FILE);
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as ProjectConfig;
}

export function writeConfig(projectRoot: string, config: ProjectConfig): void {
  const configPath = join(projectRoot, KOZANE_DIR, CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function dbPath(projectRoot: string): string {
  return join(projectRoot, KOZANE_DIR, DB_FILE);
}

export function dbUrl(projectRoot: string): string {
  return `file:${dbPath(projectRoot)}`;
}
