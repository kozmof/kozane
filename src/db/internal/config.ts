import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_UI_CONFIG, type UiConfig } from "../../lib/ui-config.js";

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

function extractUiOverrides(raw: unknown): Partial<UiConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const p = raw as Record<string, unknown>;
  const ui = p.ui;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) return {};
  const u = ui as Record<string, unknown>;
  const out: Partial<UiConfig> = {};
  const NUM_FIELDS: (keyof UiConfig)[] = [
    "defaultFontSize",
    "defaultCardWidth",
    "defaultZoom",
    "leftPanelWidth",
    "rightPanelWidth",
    "canvasWidth",
    "canvasHeight",
  ];
  const BOOL_FIELDS: (keyof UiConfig)[] = ["defaultShowFooter", "defaultShowSidePanel"];
  for (const f of NUM_FIELDS) {
    if (typeof u[f] === "number" && Number.isFinite(u[f]))
      (out as Record<string, unknown>)[f] = u[f];
  }
  for (const f of BOOL_FIELDS) {
    if (typeof u[f] === "boolean") (out as Record<string, unknown>)[f] = u[f];
  }
  if (typeof u.defaultFontFamily === "string") out.defaultFontFamily = u.defaultFontFamily;
  return out;
}

export function getWorkspaceUiConfig(): UiConfig {
  const root = getWorkspaceRoot();
  if (!root) return { ...DEFAULT_UI_CONFIG };
  try {
    const raw = readFileSync(join(root, ".kozane", "config.json"), "utf-8");
    return { ...DEFAULT_UI_CONFIG, ...extractUiOverrides(JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_UI_CONFIG };
  }
}

export function getDBURL(): string {
  const url = explicitDatabaseUrl ?? workspaceDbUrl();
  if (!url) throw new Error('No Kozane workspace found. Run "kozane init" first.');
  return url;
}

export function getWorkingCopyDefaultDir(root: string): string {
  try {
    const raw = readFileSync(join(root, ".kozane", "config.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return ".";
    const wc = (parsed as Record<string, unknown>).workingCopy;
    if (typeof wc !== "object" || wc === null) return ".";
    const dir = (wc as Record<string, unknown>).defaultDir;
    return typeof dir === "string" && dir ? dir : ".";
  } catch {
    return ".";
  }
}
