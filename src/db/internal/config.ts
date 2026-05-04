import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_UI_CONFIG, type UiConfig } from "../../cli/lib/config.js";

const explicitDatabaseUrl = process.env.DATABASE_URL;

export function findWorkspaceRoot(startDir: string | undefined): string | null {
  if (!startDir) return null;

  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".kozane", "config.json"))) return dir;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function workspaceDbUrl(): string | null {
  const root = findWorkspaceRoot(
    process.env.KOZANE_WORKSPACE_ROOT ?? process.env.INIT_CWD ?? process.cwd(),
  );
  return root ? `file:${join(root, ".kozane", "kozane.db")}` : null;
}

export function getWorkspaceRoot(): string | null {
  return findWorkspaceRoot(
    process.env.KOZANE_WORKSPACE_ROOT ?? process.env.INIT_CWD ?? process.cwd(),
  );
}

export function getWorkspaceUiConfig(): UiConfig {
  const root = getWorkspaceRoot();
  if (!root) return { ...DEFAULT_UI_CONFIG };
  try {
    const raw = readFileSync(join(root, ".kozane", "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as { ui?: Partial<UiConfig> };
    return { ...DEFAULT_UI_CONFIG, ...(parsed.ui ?? {}) };
  } catch {
    return { ...DEFAULT_UI_CONFIG };
  }
}

export function getDBURL(): string {
  const url = explicitDatabaseUrl ?? workspaceDbUrl();
  if (!url) throw new Error('No Kozane workspace found. Run "kozane init" first.');
  return url;
}
