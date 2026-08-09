import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_UI_CONFIG, type UiConfig, parseUiOverrides } from "../../lib/ui-config.js";

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

// Lenient: a bad value in one UI setting falls back to its default rather than
// failing the request. The CLI runs the same parser in strict mode (cli/lib/config.ts).
function extractUiOverrides(raw: unknown): Partial<UiConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return parseUiOverrides((raw as Record<string, unknown>).ui, { strict: false });
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

export function getTaskspaceDefaultDir(root: string): string {
  const parsed = readParsedConfig(root);
  if (!parsed) return ".";
  const taskspace = parsed.taskspace;
  if (typeof taskspace !== "object" || taskspace === null) return ".";
  const dir = (taskspace as Record<string, unknown>).defaultDir;
  return typeof dir === "string" && dir ? dir : ".";
}
