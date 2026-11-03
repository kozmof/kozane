import { join } from "node:path";
import { compactId, idMatches } from "../short-id-key.js";

/**
 * Where Kozane creates a new taskspace when no directory is given. Shared by the browser
 * route and `kozane taskspace create`.
 *
 * A namespace listed in `taskspace.namespacePaths` gets `<its path>/<taskspace name>`.
 * Otherwise, with `taskspace.namespaceDirs` on (the default), the layout is
 * `<defaultDir>/<namespace name>/<taskspace name>`, and with it off,
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

/** A `taskspace.namespacePaths` key matches more than one namespace. */
export class AmbiguousNamespacePathError extends Error {}

/**
 * The `taskspace.namespacePaths` entry for a namespace, or undefined when it has none.
 *
 * Keys are namespace IDs, in full or as the short IDs `kozane namespace list` prints, by the
 * same rules as `--namespace`. The longest matching key wins, so a full ID beats a short one.
 * A key that also matches another namespace is refused rather than guessed, because a
 * namespace created later can make a short key ambiguous.
 */
export function namespacePathFor(
  namespacePaths: Record<string, string>,
  namespaceId: string,
  allNamespaceIds: readonly string[],
): string | undefined {
  let best: string | undefined;
  for (const key of Object.keys(namespacePaths)) {
    if (!idMatches(key, namespaceId)) continue;
    if (best === undefined || compactId(key).length > compactId(best).length) best = key;
  }
  if (best === undefined) return undefined;
  const key = best;
  const matches = allNamespaceIds.filter((other) => idMatches(key, other));
  if (matches.length > 1)
    throw new AmbiguousNamespacePathError(
      `taskspace.namespacePaths key "${best}" matches ${matches.length} namespaces. ` +
        `Use the full namespace ID (${namespaceId}).`,
    );
  return namespacePaths[best];
}

type ParentOptions = {
  /** `taskspace.defaultDir` from the workspace config. */
  defaultDir: string;
  /** `taskspace.namespaceDirs` from the workspace config. */
  namespaceDirs: boolean;
  /** `taskspace.namespacePaths` from the workspace config. */
  namespacePaths: Record<string, string>;
  namespace: { id: string; name: string };
  /** Every namespace ID, to tell whether a short key is ambiguous. */
  allNamespaceIds: readonly string[];
};

/**
 * The directory a new taskspace's own directory goes in, relative to the root or absolute.
 * Throw {@link AmbiguousNamespacePathError} when a `namespacePaths` key is ambiguous.
 */
export function taskspaceParentDir({
  defaultDir,
  namespaceDirs,
  namespacePaths,
  namespace,
  allNamespaceIds,
}: ParentOptions): string {
  const custom = namespacePathFor(namespacePaths, namespace.id, allNamespaceIds);
  if (custom !== undefined) return custom;
  return namespaceDirs
    ? join(defaultDir, namespaceDirName(namespace.name, namespace.id))
    : defaultDir;
}
