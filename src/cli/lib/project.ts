import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type WorkspaceConfig, KOZANE_DIR, CONFIG_FILE, readConfig } from "./config.js";

export type KozaneWorkspace = {
  root: string;
  config: WorkspaceConfig;
};

export function detectWorkspace(startDir: string = process.cwd()): KozaneWorkspace | null {
  let dir = startDir;
  while (true) {
    const configPath = join(dir, KOZANE_DIR, CONFIG_FILE);
    if (existsSync(configPath)) {
      return { root: dir, config: readConfig(dir) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

export function requireWorkspace(startDir: string = process.cwd()): KozaneWorkspace {
  const workspace = detectWorkspace(startDir);
  if (!workspace) {
    console.error('No Kozane workspace found. Run "kozane init" first.');
    process.exit(1);
  }
  return workspace;
}
