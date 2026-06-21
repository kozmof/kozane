import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_UI_CONFIG,
  type UiConfig,
  UI_NUM_RANGES,
  UI_BOOL_FIELDS,
  UI_STR_FIELDS,
} from "../../lib/ui-config.js";

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

// Resolved lazily on first call so tests can set KOZANE_WORKSPACE_ROOT in
// beforeEach. After the first resolution the value is cached for the lifetime
// of the process (production never changes the workspace mid-run).
let _workspaceRoot: string | null | undefined = undefined;
let _parsedConfig: Record<string, unknown> | null | undefined = undefined;
let _uiConfig: UiConfig | undefined = undefined;

function resolveWorkspaceRoot(): string | null {
  if (_workspaceRoot !== undefined) return _workspaceRoot;
  _workspaceRoot = findWorkspaceRoot(
    process.env.KOZANE_WORKSPACE_ROOT ?? process.env.INIT_CWD ?? process.cwd(),
  );
  return _workspaceRoot;
}

// For tests only — resets the cache so a fresh KOZANE_WORKSPACE_ROOT is picked up.
export function _resetWorkspaceRootForTest(): void {
  _workspaceRoot = undefined;
  _parsedConfig = undefined;
  _uiConfig = undefined;
}

function readParsedConfig(root: string): Record<string, unknown> | null {
  if (_parsedConfig !== undefined) return _parsedConfig;
  try {
    const raw = readFileSync(join(root, ".kozane", "config.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    _parsedConfig =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    _parsedConfig = null;
  }
  return _parsedConfig;
}

function workspaceDbUrl(): string | null {
  const root = resolveWorkspaceRoot();
  return root ? `file:${join(root, ".kozane", "kozane.db")}` : null;
}

export function getWorkspaceRoot(): string | null {
  return resolveWorkspaceRoot();
}

function extractUiOverrides(raw: unknown): Partial<UiConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const p = raw as Record<string, unknown>;
  const ui = p.ui;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) return {};
  const u = ui as Record<string, unknown>;
  const out: Partial<UiConfig> = {};
  for (const f of Object.keys(UI_NUM_RANGES)) {
    if (typeof u[f] === "number" && Number.isFinite(u[f]))
      (out as Record<string, unknown>)[f] = u[f];
  }
  for (const f of UI_BOOL_FIELDS) {
    if (typeof u[f] === "boolean") (out as Record<string, unknown>)[f] = u[f];
  }
  for (const f of UI_STR_FIELDS) {
    if (typeof u[f] === "string") (out as Record<string, unknown>)[f] = u[f];
  }
  return out;
}

export function getWorkspaceUiConfig(): UiConfig {
  if (_uiConfig) return _uiConfig;
  const root = resolveWorkspaceRoot();
  if (!root) return (_uiConfig = { ...DEFAULT_UI_CONFIG });
  const parsed = readParsedConfig(root);
  return (_uiConfig = { ...DEFAULT_UI_CONFIG, ...extractUiOverrides(parsed) });
}

export function getDBURL(): string {
  const url = process.env.DATABASE_URL ?? workspaceDbUrl();
  if (!url) throw new Error('No Kozane workspace found. Run "kozane init" first.');
  return url;
}

export function getWorkingCopyDefaultDir(root: string): string {
  const parsed = readParsedConfig(root);
  if (!parsed) return ".";
  const wc = parsed.workingCopy;
  if (typeof wc !== "object" || wc === null) return ".";
  const dir = (wc as Record<string, unknown>).defaultDir;
  return typeof dir === "string" && dir ? dir : ".";
}
