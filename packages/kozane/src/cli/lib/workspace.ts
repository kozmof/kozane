import { type WorkspaceConfig, readConfig } from "./config.js";
import { findWorkspaceRoot } from "../../db/internal/config.js";

export type KozaneWorkspace = {
  root: string;
  config: WorkspaceConfig;
};

export function detectWorkspace(startDir: string = process.cwd()): KozaneWorkspace | null {
  const root = findWorkspaceRoot(startDir);
  if (!root) return null;
  return { root, config: readConfig(root) };
}

export function requireWorkspace(startDir: string = process.cwd()): KozaneWorkspace {
  const workspace = detectWorkspace(startDir);
  if (!workspace) {
    console.error('No Kozane workspace found. Run "kozane init" first.');
    process.exit(1);
  }
  return workspace;
}
