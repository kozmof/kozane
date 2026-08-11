import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "../../lib/constants.js";
import {
  type ConfigIssue,
  type UiConfig,
  type ValidationResult,
  UI_KNOWN_KEYS,
  validateUiOverrides,
} from "../../lib/ui-config.js";

export type WorkspaceConfig = {
  name: string;
  server: {
    host: string;
    port: number;
  };
  taskspace: {
    defaultDir: string;
    searchRoots: string[];
  };
  ui?: Partial<UiConfig>;
};

export type SectionName = "server" | "taskspace";

/**
 * One validated field of a workspace config. `check` returns the reason the value is
 * unacceptable, or `null` when it passes. Messages carry their own path so callers can
 * print or throw them verbatim.
 */
type FieldRule = {
  path: string;
  key: string;
  /** Value used when the field is absent, or present but invalid. */
  fallback: unknown;
  check: (value: unknown) => string | null;
};

type FieldGroup = {
  /** `null` for fields living at the top level of the config. */
  section: SectionName | null;
  /** Optional sections fall back to their defaults instead of being reported missing. */
  required: boolean;
  rules: FieldRule[];
};

function stringRule(path: string, key: string, fallback: string): FieldRule {
  return {
    path,
    key,
    fallback,
    check: (value) => (typeof value === "string" ? null : `${path} must be a string`),
  };
}

/**
 * The single description of what a `.kozane/config.json` may contain. `readConfig` walks
 * it to build a config and reject a bad one; `kozane doctor config` walks it to report
 * every problem at once. Keeping one table means the two can never disagree.
 *
 * Order matters: it is the order problems are reported in, and the first error is the one
 * `readConfig` throws.
 */
const FIELD_GROUPS: FieldGroup[] = [
  {
    section: null,
    required: true,
    rules: [stringRule("name", "name", "")],
  },
  {
    // `server` and its fields are optional: omitting one falls back to the built-in
    // default, so a workspace can stay on whatever port Kozane ships with.
    section: "server",
    required: false,
    rules: [
      stringRule("server.host", "host", DEFAULT_SERVER_HOST),
      {
        path: "server.port",
        key: "port",
        fallback: DEFAULT_SERVER_PORT,
        check: (value) => {
          if (typeof value !== "number") return "server.port must be a number";
          if (!Number.isInteger(value) || value < 0 || value > 65535) {
            return "server.port must be between 0 and 65535";
          }
          return null;
        },
      },
    ],
  },
  {
    section: "taskspace",
    required: true,
    rules: [
      stringRule("taskspace.defaultDir", "defaultDir", "."),
      {
        path: "taskspace.searchRoots",
        key: "searchRoots",
        fallback: ["."],
        check: (value) =>
          Array.isArray(value) && value.every((entry) => typeof entry === "string")
            ? null
            : "taskspace.searchRoots must be an array of strings",
      },
    ],
  },
];

export const TOP_LEVEL_KEYS = ["name", "server", "taskspace", "ui"];

export const SECTION_KEYS: Record<SectionName, string[]> = {
  server: ["host", "port"],
  taskspace: ["defaultDir", "searchRoots"],
};

/** Keys a valid config may carry, by the dotted path of their parent. */
export function knownKeys(): { parent: string; keys: string[] }[] {
  return [
    { parent: "", keys: TOP_LEVEL_KEYS },
    { parent: "server", keys: SECTION_KEYS.server },
    { parent: "taskspace", keys: SECTION_KEYS.taskspace },
    { parent: "ui", keys: UI_KNOWN_KEYS },
  ];
}

export type SectionDefaults = {
  section: string;
  defaults: { key: string; value: unknown }[];
};

/**
 * Sections whose keys each fall back to a default when unset, with the values that stand
 * in for them, for reporting what a config is actually running with.
 */
export function optionalSectionDefaults(): SectionDefaults[] {
  return FIELD_GROUPS.filter((group) => !group.required && group.section !== null).map((group) => ({
    section: group.section as string,
    defaults: group.rules.map((rule) => ({ key: rule.key, value: rule.fallback })),
  }));
}

function error(path: string, message: string, found?: unknown): ConfigIssue {
  return { path, severity: "error", message, found };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Edit distance, capped at `limit` so far-apart keys bail out early. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The known key an unknown one was most likely meant to be, or `null` when nothing is
 * close enough. Case is ignored first, so `defaultfontsize` still suggests its field.
 */
export function suggestKey(unknown: string, known: readonly string[]): string | null {
  const limit = unknown.length <= 4 ? 1 : 2;
  let best: { key: string; distance: number } | null = null;
  for (const key of known) {
    const distance = editDistance(unknown.toLowerCase(), key.toLowerCase(), limit);
    if (distance <= limit && (!best || distance < best.distance)) best = { key, distance };
  }
  return best?.key ?? null;
}

function unknownKeyIssues(parent: string, raw: Record<string, unknown>): ConfigIssue[] {
  const known = knownKeys().find((entry) => entry.parent === parent)?.keys ?? [];
  return Object.keys(raw)
    .filter((key) => !known.includes(key))
    .map((key) => {
      const path = parent ? `${parent}.${key}` : key;
      const suggestion = suggestKey(key, known);
      return {
        path,
        severity: "warning" as const,
        message: suggestion
          ? `${path} is not a known key — did you mean "${suggestion}"?`
          : `${path} is not a known key`,
      };
    });
}

/**
 * Validates a parsed `.kozane/config.json`, collecting every problem rather than stopping
 * at the first. `value` is usable only when no issue has severity `error`: invalid and
 * missing required fields are filled with placeholders so the shape stays whole.
 */
export function validateWorkspaceConfig(parsed: unknown): ValidationResult<WorkspaceConfig> {
  const issues: ConfigIssue[] = [];
  const resolved = new Map<string, unknown>();

  if (!isPlainObject(parsed)) {
    issues.push(error("", "config must be a JSON object", parsed));
    return { value: buildConfig(resolved, undefined), issues };
  }

  for (const group of FIELD_GROUPS) {
    let raw: Record<string, unknown> | undefined;
    if (group.section === null) {
      raw = parsed;
    } else {
      const section = parsed[group.section];
      if (section === undefined) {
        if (group.required) issues.push(error(group.section, `${group.section} is missing`));
      } else if (!isPlainObject(section)) {
        issues.push(error(group.section, `${group.section} must be an object`, section));
      } else {
        raw = section;
      }
    }

    for (const rule of group.rules) {
      const value = raw?.[rule.key];
      if (value === undefined) {
        // A missing field of an optional section is not a problem; one of a required
        // section is, and so is a section that failed above (`raw` is undefined there).
        if (group.required && raw !== undefined) {
          issues.push(error(rule.path, `${rule.path} is missing`));
        }
        resolved.set(rule.path, rule.fallback);
        continue;
      }
      const message = rule.check(value);
      if (message) {
        issues.push(error(rule.path, message, value));
        resolved.set(rule.path, rule.fallback);
        continue;
      }
      resolved.set(rule.path, value);
    }
  }

  const ui = validateUiOverrides(parsed.ui);
  issues.push(...ui.issues);

  issues.push(...unknownKeyIssues("", parsed));
  for (const section of Object.keys(SECTION_KEYS) as SectionName[]) {
    const raw = parsed[section];
    if (isPlainObject(raw)) issues.push(...unknownKeyIssues(section, raw));
  }
  if (isPlainObject(parsed.ui)) issues.push(...unknownKeyIssues("ui", parsed.ui));

  return { value: buildConfig(resolved, parsed.ui === undefined ? undefined : ui.value), issues };
}

function buildConfig(
  resolved: Map<string, unknown>,
  ui: Partial<UiConfig> | undefined,
): WorkspaceConfig {
  const field = <T>(path: string, fallback: T): T => (resolved.get(path) as T) ?? fallback;
  return {
    name: field("name", ""),
    server: {
      host: field("server.host", DEFAULT_SERVER_HOST),
      port: field("server.port", DEFAULT_SERVER_PORT),
    },
    taskspace: {
      defaultDir: field("taskspace.defaultDir", "."),
      searchRoots: field<string[]>("taskspace.searchRoots", ["."]),
    },
    ...(ui !== undefined && { ui }),
  };
}
