import { DEFAULT_TASKSPACE_DIR, DEFAULT_TASKSPACE_NAMESPACE_DIRS } from "./constants/workspace.js";
import { isPlainObject } from "./plain-object.js";
import { MIN_SHORT_ID_LENGTH, compactId } from "./short-id-key.js";

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
  defaultDir: string;
  namespaceDirs: boolean;
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
 * digits and dashes, so a key with anything else is most likely a namespace name. Short IDs
 * are at least {@link MIN_SHORT_ID_LENGTH} digits, as `kozane namespace list` prints them,
 * so a word made of hex letters, such as `cafe`, is refused too.
 */
export function namespacePathsIssue(value: unknown): string | null {
  const path = "taskspace.namespacePaths";
  if (!isPlainObject(value)) return `${path} must be an object of namespace IDs to directories`;
  for (const [key, dir] of Object.entries(value)) {
    if (!/^[0-9a-f-]+$/i.test(key) || compactId(key).length < MIN_SHORT_ID_LENGTH)
      return (
        `${path} key "${key}" must be a namespace ID, as kozane namespace list shows it, ` +
        `of at least ${MIN_SHORT_ID_LENGTH} characters`
      );
    if (typeof dir !== "string" || !dir.trim())
      return `${path}.${key} must be a nonempty directory path`;
  }
  return null;
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
      // namespacePathsIssue has checked every value is a string.
      namespacePaths: isPlainObject(namespacePaths)
        ? (namespacePaths as Record<string, string>)
        : {},
    },
  };
}
