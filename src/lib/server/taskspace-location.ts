import { join } from "node:path";

/**
 * Where Kozane creates a new taskspace when no directory is given. Shared by the browser
 * route and `kozane taskspace create`.
 *
 * With `taskspace.namespaceDirs` on (the default), the layout is
 * `<defaultDir>/<namespace name>/<taskspace name>`. With it off, it is
 * `<defaultDir>/<taskspace name>`.
 */

/** Windows refuses these as file names, with or without an extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Turn a namespace name into one plain folder name. Characters that are not allowed in
 * folder names on common systems become `-`, and so does each run of whitespace inside the
 * name. Leading dots are dropped so the folder is not hidden, and trailing dots and spaces
 * are dropped because Windows strips them. Use `fallback`, such as the namespace ID, when
 * nothing usable is left.
 */
export function namespaceDirName(name: string, fallback: string): string {
  const cleaned = name
    // oxlint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "-")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .trim()
    .replace(/\s+/g, "-");
  if (!cleaned) return fallback;
  return RESERVED_NAMES.test(cleaned) ? `${cleaned}-` : cleaned;
}

type ParentOptions = {
  /** `taskspace.defaultDir` from the workspace config. */
  defaultDir: string;
  /** `taskspace.namespaceDirs` from the workspace config. */
  namespaceDirs: boolean;
  namespace: { id: string; name: string };
};

/** The directory a new taskspace's own directory goes in, relative to the root or absolute. */
export function taskspaceParentDir({
  defaultDir,
  namespaceDirs,
  namespace,
}: ParentOptions): string {
  return namespaceDirs
    ? join(defaultDir, namespaceDirName(namespace.name, namespace.id))
    : defaultDir;
}
