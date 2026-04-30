import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ProjectConfig, KOZANE_DIR, CONFIG_FILE, readConfig } from "./config.js";

export type KozaneProject = {
  root: string;
  config: ProjectConfig;
};

export function detectProject(startDir: string = process.cwd()): KozaneProject | null {
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

export function requireProject(startDir: string = process.cwd()): KozaneProject {
  const project = detectProject(startDir);
  if (!project) {
    console.error('No Kozane project found. Run "kozane init" first.');
    process.exit(1);
  }
  return project;
}
