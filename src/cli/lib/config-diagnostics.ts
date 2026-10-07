import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ConfigIssue, DEFAULT_UI_CONFIG, UI_KNOWN_KEYS } from "../../lib/ui-config.js";
import { CONFIG_FILE, KOZANE_DIR } from "./config.js";
import {
  type SectionDefaults,
  optionalSectionDefaults,
  validateWorkspaceConfig,
} from "./config-schema.js";

export type ConfigNote = {
  /** Summary line, e.g. `ui: 13 of 23 keys not set — using defaults`. */
  message: string;
  /** `key: value` for each unset key, in schema order. */
  details: string[];
};

export type ConfigReport = {
  /** Path the config was read from, whether or not it could be read. */
  path: string;
  /** Errors first, then warnings. Preserve declaration order within each group. */
  issues: ConfigIssue[];
  /** Unset optional keys and the defaults standing in for them, by section. */
  notes: ConfigNote[];
};

export function configPath(workspaceRoot: string): string {
  return join(workspaceRoot, KOZANE_DIR, CONFIG_FILE);
}

function fileError(path: string, message: string): ConfigReport {
  return { path, issues: [{ path: "", severity: "error", message }], notes: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** Sections whose missing keys use defaults, including `ui`. */
function defaultingSections(): SectionDefaults[] {
  return [
    ...optionalSectionDefaults(),
    {
      section: "ui",
      defaults: UI_KNOWN_KEYS.map((key) => ({ key, value: DEFAULT_UI_CONFIG[key] })),
    },
  ];
}

function defaultNotes(parsed: Record<string, unknown>): ConfigNote[] {
  const notes: ConfigNote[] = [];

  for (const { section, defaults } of defaultingSections()) {
    const raw = parsed[section];
    // The malformed section already has an error. Do not also report each of its fields as
    // unset.
    if (raw !== undefined && !isPlainObject(raw)) continue;

    const unset = defaults.filter(({ key }) => raw?.[key] === undefined);
    if (unset.length === 0) continue;
    notes.push({
      message: `${section}: ${unset.length} of ${defaults.length} keys not set — using defaults`,
      details: unset.map(({ key, value }) => `${key}: ${show(value)}`),
    });
  }

  return notes;
}

/**
 * Report all configuration problems for `kozane doctor config`, including unreadable files,
 * missing or unknown keys, and invalid values.
 */
export function diagnoseConfig(workspaceRoot: string): ConfigReport {
  const path = configPath(workspaceRoot);

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fileError(path, `config.json is missing — run "kozane init"`);
    return fileError(path, `config.json could not be read: ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fileError(path, `config.json is not valid JSON: ${(e as Error).message}`);
  }

  const { issues } = validateWorkspaceConfig(parsed);
  const ordered = [
    ...issues.filter((issue) => issue.severity === "error"),
    ...issues.filter((issue) => issue.severity === "warning"),
  ];

  return {
    path,
    issues: ordered,
    notes: isPlainObject(parsed) ? defaultNotes(parsed) : [],
  };
}
