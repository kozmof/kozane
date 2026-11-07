import { DEFAULT_TASKSPACE_DIR, DEFAULT_TASKSPACE_NAMESPACE_DIRS } from "./constants/workspace.js";
import { isPlainObject } from "./plain-object.js";
import {
  FULL_ID_LENGTH,
  MIN_SHORT_ID_LENGTH,
  SHORT_ID_KEY_LENGTH,
  compactId,
} from "./short-id-key.js";

/**
 * Settings that choose a new taskspace's directory. The CLI config schema and server share
 * these checks so both use the same placement rules and reject invalid settings.
 *
 * The browser also requires the target to be inside the workspace. The CLI accepts
 * `defaultDir` and `namespacePaths` entries that point outside it.
 */
export type TaskspacePlacement = {
  /** Directory for new taskspaces, relative to the workspace root or absolute. */
  defaultDir: string;
  /** Put each namespace's new taskspaces in a folder named after it under `defaultDir`. */
  namespaceDirs: boolean;
  /** Map full or short namespace IDs to directories for new taskspaces. */
  namespacePaths: Record<string, string>;
};

export function defaultDirIssue(value: unknown): string | null {
  return typeof value === "string" ? null : "taskspace.defaultDir must be a string";
}

export function namespaceDirsIssue(value: unknown): string | null {
  return typeof value === "boolean" ? null : "taskspace.namespaceDirs must be true or false";
}

/**
 * `taskspace.namespacePaths` maps a namespace ID, full or short, to a directory. IDs are hex
 * digits and dashes, so a key with anything else is most likely a namespace name. Only key
 * lengths `idMatches` can match are accepted: a short ID of
 * {@link MIN_SHORT_ID_LENGTH} to {@link SHORT_ID_KEY_LENGTH} digits, as `kozane namespace
 * list` prints it, or the full ID. A word made of hex letters, such as `cafe`, is refused,
 * and so is a longer prefix, such as the start of a UUID, which would match nothing. Two
 * keys that differ only in case or dashes are refused too, since they name the same ID.
 */
export function namespacePathsIssue(value: unknown): string | null {
  const path = "taskspace.namespacePaths";
  if (!isPlainObject(value)) return `${path} must be an object of namespace IDs to directories`;
  // Keys by their compact form. `ABCDEF1` and `abcdef1`, or a full ID with and without
  // dashes, name the same namespace, and nothing would decide which directory wins.
  const seen = new Map<string, string>();
  for (const [key, dir] of Object.entries(value)) {
    const digits = compactId(key).length;
    const matchable =
      (digits >= MIN_SHORT_ID_LENGTH && digits <= SHORT_ID_KEY_LENGTH) || digits === FULL_ID_LENGTH;
    if (!/^[0-9a-f-]+$/i.test(key) || !matchable)
      return (
        `${path} key "${key}" must be a namespace ID as kozane namespace list shows it ` +
        `(${MIN_SHORT_ID_LENGTH} to ${SHORT_ID_KEY_LENGTH} characters) or the full ID`
      );
    if (typeof dir !== "string" || !dir.trim())
      return `${path}.${key} must be a nonempty directory path`;
    const same = seen.get(compactId(key));
    if (same !== undefined)
      return `${path} keys "${same}" and "${key}" name the same namespace; keep one of them`;
    seen.set(compactId(key), key);
  }
  return null;
}

/** True when {@link namespacePathsIssue} finds nothing wrong, narrowing the type to match. */
function isValidNamespacePaths(value: unknown): value is Record<string, string> {
  return namespacePathsIssue(value) === null;
}

/**
 * Read the placement settings from a parsed `taskspace` section. A field that is left out
 * uses its default. A field that is present but invalid is returned as an issue instead of
 * being skipped. This matches CLI validation and prevents invalid settings from silently
 * changing the target directory.
 */
export function readTaskspacePlacement(
  section: unknown,
): { ok: true; value: TaskspacePlacement } | { ok: false; issue: string } {
  if (section !== undefined && !isPlainObject(section))
    return { ok: false, issue: "taskspace must be an object" };
  const { defaultDir, namespaceDirs, namespacePaths } = section ?? {};
  const present = (value: unknown, check: (value: unknown) => string | null) =>
    value === undefined ? null : check(value);
  const issue =
    present(defaultDir, defaultDirIssue) ??
    present(namespaceDirs, namespaceDirsIssue) ??
    present(namespacePaths, namespacePathsIssue);
  if (issue) return { ok: false, issue };
  return {
    ok: true,
    value: {
      defaultDir: typeof defaultDir === "string" ? defaultDir : DEFAULT_TASKSPACE_DIR,
      namespaceDirs:
        typeof namespaceDirs === "boolean" ? namespaceDirs : DEFAULT_TASKSPACE_NAMESPACE_DIRS,
      namespacePaths: isValidNamespacePaths(namespacePaths) ? namespacePaths : {},
    },
  };
}
