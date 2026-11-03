import { DEFAULT_TASKSPACE_DIR, DEFAULT_TASKSPACE_NAMESPACE_DIRS } from "./constants/workspace.js";
import { isPlainObject } from "./plain-object.js";
import {
  FULL_ID_LENGTH,
  MIN_SHORT_ID_LENGTH,
  SHORT_ID_KEY_LENGTH,
  compactId,
} from "./short-id-key.js";

/**
 * The `taskspace` settings that decide where a new taskspace goes. The CLI's config schema
 * and the server both check them with the functions here, so `kozane taskspace create` and
 * the browser always pick the same directory, or both refuse the same config.
 *
 * One difference is deliberate: the browser only creates taskspaces inside the workspace
 * root. A `defaultDir` or `namespacePaths` entry that points outside it works with
 * `kozane taskspace create`, but the browser refuses it.
 */
export type TaskspacePlacement = {
  /** Directory for new taskspaces, relative to the workspace root or absolute. */
  defaultDir: string;
  /** Put each namespace's new taskspaces in a folder named after it under `defaultDir`. */
  namespaceDirs: boolean;
  /** Namespace ID, full or short, to the directory its new taskspaces go in. */
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
 * and so is a longer prefix, such as the start of a UUID, which would match nothing.
 */
export function namespacePathsIssue(value: unknown): string | null {
  const path = "taskspace.namespacePaths";
  if (!isPlainObject(value)) return `${path} must be an object of namespace IDs to directories`;
  for (const [key, dir] of Object.entries(value)) {
    const digits = compactId(key).length;
    const matchable =
      (digits >= MIN_SHORT_ID_LENGTH && digits <= SHORT_ID_KEY_LENGTH) ||
      digits === FULL_ID_LENGTH;
    if (!/^[0-9a-f-]+$/i.test(key) || !matchable)
      return (
        `${path} key "${key}" must be a namespace ID as kozane namespace list shows it ` +
        `(${MIN_SHORT_ID_LENGTH} to ${SHORT_ID_KEY_LENGTH} characters) or the full ID`
      );
    if (typeof dir !== "string" || !dir.trim())
      return `${path}.${key} must be a nonempty directory path`;
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
 * being skipped, because the CLI refuses it too: skipping it would put the taskspace in a
 * different directory than `kozane taskspace create` would.
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
