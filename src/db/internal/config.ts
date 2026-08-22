import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_UI_CONFIG, type UiConfig, parseUiOverrides } from "../../lib/ui-config.js";
import { fileSignature } from "../../lib/server/file-signature.js";

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
// Which config file the two caches below were built from. `undefined` means nothing has
// been read yet; `null` means there was no readable file, which is itself worth caching.
let _configSignature: string | null | undefined = undefined;
let _parsedConfig: Record<string, unknown> | null = null;
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
  _configSignature = undefined;
  _parsedConfig = null;
  _uiConfig = undefined;
}

function configPath(root: string): string {
  return join(root, ".kozane", "config.json");
}

/**
 * The parsed config, re-read whenever the file has changed underneath. Held rather than
 * re-parsed on every call because `getWorkspaceUiConfig` runs on each page load, and
 * re-checked rather than cached for the process lifetime because the config is a file the
 * user is invited to hand-edit — settings that appeared to do nothing until the server was
 * restarted would look like settings that do not work.
 */
function readParsedConfig(root: string): Record<string, unknown> | null {
  const signature = fileSignature(configPath(root));
  if (_configSignature !== undefined && _configSignature === signature) return _parsedConfig;
  _configSignature = signature;
  // Derived from the same bytes, so it is rebuilt on the next call rather than left stale.
  _uiConfig = undefined;
  if (signature === null) {
    _parsedConfig = null;
    return null;
  }
  try {
    const raw = readFileSync(configPath(root), "utf-8");
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

/**
 * The UI settings of a workspace whose root the caller already holds — the CLI, which
 * finds it with `requireWorkspace()` rather than from the environment
 * {@link getWorkspaceUiConfig} reads. Same file, same parse, same cache; only how the root
 * was arrived at differs, and asking the two to agree is what a CLI reading these settings
 * would otherwise rest on. `getTaskspaceDefaultDir` takes a root for the same reason.
 */
export function getUiConfigForRoot(root: string): UiConfig {
  // Called first: it clears the derived cache below when the file has changed.
  const parsed = readParsedConfig(root);
  return (_uiConfig ??= { ...DEFAULT_UI_CONFIG, ...extractUiOverrides(parsed) });
}

export function getWorkspaceUiConfig(): UiConfig {
  const root = resolveWorkspaceRoot();
  if (!root) return (_uiConfig ??= { ...DEFAULT_UI_CONFIG });
  return getUiConfigForRoot(root);
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
