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
 * What was last read out of one config file, keyed by that file's path.
 *
 * Per path rather than one slot for whichever root was asked about last, because
 * `getUiConfigForRoot` takes a root from its caller and the CLI hands it one it found
 * itself. Two roots in a single process shared the one slot, so each read evicted the
 * other's and the cache stopped being a cache — and the correctness of the arrangement
 * rested entirely on `fileSignature` including the inode, which is a lot to ask of a
 * field documented as a heuristic about *versions of one file*.
 *
 * `signature: null` records that there was no readable file, which is worth remembering
 * too. Unbounded in principle; in practice a process sees one workspace, or the handful a
 * test suite creates.
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

// For tests only — resets the cache so a fresh KOZANE_WORKSPACE_ROOT is picked up.
export function _resetWorkspaceRootForTest(): void {
  _workspaceRoot = undefined;
  configCache.clear();
  _rootlessUiConfig = undefined;
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
