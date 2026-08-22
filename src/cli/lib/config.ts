import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeServerProcess } from "../../lib/server/runtime-state.js";
import { writeFileAtomic } from "../../lib/server/atomic-write.js";
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "../../lib/constants.js";
import { type UiConfig, DEFAULT_UI_CONFIG } from "../../lib/ui-config.js";
import { type WorkspaceConfig, validateWorkspaceConfig } from "./config-schema.js";

export type { UiConfig, WorkspaceConfig };
export { DEFAULT_UI_CONFIG };

export const KOZANE_DIR = ".kozane";
export const CONFIG_FILE = "config.json";
export const DB_FILE = "kozane.db";
export const MIGRATION_DIR = "drizzle";

export function defaultConfig(name: string): WorkspaceConfig {
  return {
    name,
    server: { host: DEFAULT_SERVER_HOST, port: DEFAULT_SERVER_PORT },
    taskspace: {
      defaultDir: ".",
      searchRoots: ["."],
    },
    ui: { ...DEFAULT_UI_CONFIG },
  };
}

/**
 * Reads and validates the workspace config, rejecting the first problem found. Strict by
 * design: the CLI is reading a file the user just edited, so a bad value is reported
 * rather than silently dropped. The server validates the same config leniently through
 * the same rules (db/internal/config.ts), so the two can never disagree on validity.
 * `kozane doctor config` reports every problem instead of only the first.
 */
export function readConfig(projectRoot: string): WorkspaceConfig {
  const configPath = join(projectRoot, KOZANE_DIR, CONFIG_FILE);
  const raw = readFileSync(configPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid Kozane config at ${configPath}`);
  }

  const { value, issues } = validateWorkspaceConfig(parsed);
  // Warnings (unknown keys) are for the doctor to report, not a reason to refuse to run.
  const firstError = issues.find((issue) => issue.severity === "error");
  if (firstError) throw new Error(`Invalid Kozane config: ${firstError.message}`);
  return value;
}

/**
 * Writes the workspace config atomically. Not only for the half-written file a crash would
 * otherwise leave behind in the one file that says a workspace is a workspace: the rename
 * gives it a new inode, which is how the readers' cache (`db/internal/config.ts`, keyed by
 * {@link fileSignature}) tells a rewrite from the version it already parsed. Written in
 * place, two configs of the same length written inside one filesystem timestamp tick are
 * indistinguishable, and the second would go unread.
 */
export function writeConfig(projectRoot: string, config: WorkspaceConfig): void {
  const configPath = join(projectRoot, KOZANE_DIR, CONFIG_FILE);
  writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function dbPath(projectRoot: string): string {
  return join(projectRoot, KOZANE_DIR, DB_FILE);
}

export function dbUrl(projectRoot: string): string {
  return `file:${dbPath(projectRoot)}`;
}

/** Database used by interactive CLI commands for the active workspace session. */
export function commandDbUrl(projectRoot: string): string {
  const state = activeServerProcess(projectRoot);
  if (state?.memory && state.databaseUrl) return state.databaseUrl;
  return dbUrl(projectRoot);
}
