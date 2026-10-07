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
/**
 * Parsed configuration keyed by file path. Keep roots separate so alternating reads do not
 * evict each other. A null signature records an unreadable or missing file.
 */
type ConfigCacheEntry = {
  signature: string | null;
  parsed: Record<string, unknown> | null;
  /** Derived from `parsed`, so it lives and dies with the entry rather than beside it. */
  ui?: UiConfig;
};
const configCache = new Map<string, ConfigCacheEntry>();
/** The UI defaults handed out when there is no workspace at all, and so no file to key by. */
let _rootlessUiConfig: UiConfig | undefined = undefined;

function resolveWorkspaceRoot(): string | null {
  if (_workspaceRoot !== undefined) return _workspaceRoot;
  _workspaceRoot = findWorkspaceRoot(
    process.env.KOZANE_WORKSPACE_ROOT ?? process.env.INIT_CWD ?? process.cwd(),
  );
  return _workspaceRoot;
}

// Reset the cache in tests so a new `KOZANE_WORKSPACE_ROOT` is read.
export function _resetWorkspaceRootForTest(): void {
  _workspaceRoot = undefined;
  configCache.clear();
  _rootlessUiConfig = undefined;
}

function configPath(root: string): string {
  return join(root, ".kozane", "config.json");
}

/**
 * Cache parsed configuration and check its file signature on access so edits take effect
 * without restarting the server.
 */
function parseConfigFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The cache entry for `root`, re-read whenever the file behind it has changed. */
function configEntry(root: string): ConfigCacheEntry {
  const path = configPath(root);
  const signature = fileSignature(path);
  const cached = configCache.get(path);
  if (cached && cached.signature === signature) return cached;
  // A fresh entry rather than a mutated one, which is what drops the derived `ui` with the
  // bytes it came from instead of leaving it to be cleared by hand.
  const entry: ConfigCacheEntry = {
    signature,
    parsed: signature === null ? null : parseConfigFile(path),
  };
  configCache.set(path, entry);
  return entry;
}

function readParsedConfig(root: string): Record<string, unknown> | null {
  return configEntry(root).parsed;
}

function workspaceDbUrl(): string | null {
  const root = resolveWorkspaceRoot();
  return root ? `file:${join(root, ".kozane", "kozane.db")}` : null;
}

export function getWorkspaceRoot(): string | null {
  return resolveWorkspaceRoot();
}

// The server uses the same parser as the CLI but skips invalid fields.
function extractUiOverrides(raw: unknown): Partial<UiConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return parseUiOverrides((raw as Record<string, unknown>).ui, { strict: false });
}

/**
 * Read UI settings for an explicit workspace root, using the same parsing and cache as {@link
 * getWorkspaceUiConfig}.
 */
export function getUiConfigForRoot(root: string): UiConfig {
  const entry = configEntry(root);
  return (entry.ui ??= { ...DEFAULT_UI_CONFIG, ...extractUiOverrides(entry.parsed) });
}

export function getWorkspaceUiConfig(): UiConfig {
  const root = resolveWorkspaceRoot();
  if (!root) return (_rootlessUiConfig ??= { ...DEFAULT_UI_CONFIG });
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
