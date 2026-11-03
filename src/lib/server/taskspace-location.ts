import { join } from "node:path";
import { compactId, idMatches, shortIdKey } from "../short-id-key.js";

/**
 * Where Kozane creates a new taskspace when no directory is given. Shared by the browser
 * route and `kozane taskspace create`.
 *
 * A namespace listed in `taskspace.namespacePaths` gets `<its path>/<taskspace name>`.
 * Otherwise, with `taskspace.namespaceDirs` on (the default), the layout is
 * `<defaultDir>/<namespace name>/<taskspace name>`, and with it off,
 * `<defaultDir>/<taskspace name>`.
 */

/**
 * Windows refuses these as file names, with or without an extension, so `con.txt` is
 * tested by the part before its first dot.
 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Longest folder name, in characters. Most file systems allow 255 bytes per name. At up to
 * 4 bytes per character, 60 leaves room for the short ID `namespaceFolders` may add.
 */
const MAX_DIR_NAME_LENGTH = 60;

/**
 * Turn a namespace name into one plain folder name. The name is put in Unicode NFC form,
 * so the same name typed on macOS and Linux gives the same folder. Characters that are not
 * allowed in folder names on common systems become `-`, and so does each run of whitespace
 * inside the name. Leading dots are dropped so the folder is not hidden, and trailing dots
 * and spaces are dropped because Windows strips them. Long names are cut to
 * {@link MAX_DIR_NAME_LENGTH} characters. Use `fallback`, such as the namespace ID, when
 * nothing usable is left.
 */
export function namespaceDirName(name: string, fallback: string): string {
  const stripEnds = (text: string) =>
    text
      .trim()
      .replace(/^\.+/, "")
      .replace(/[.\s]+$/, "")
      .trim();
  const cleaned = stripEnds(
    name
      .normalize("NFC")
      // oxlint-disable-next-line no-control-regex
      .replace(/[/\\:*?"<>|\x00-\x1f]/g, "-"),
  ).replace(/\s+/g, "-");
  // Cut by code point so a character outside the BMP is never split in half.
  const short = stripEnds([...cleaned].slice(0, MAX_DIR_NAME_LENGTH).join(""));
  if (!short) return fallback;
  const base = short.split(".")[0];
  return RESERVED_NAMES.test(base) ? `${base}-${short.slice(base.length)}` : short;
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

export type NamespaceRef = { id: string; name: string };

/**
 * The folder each namespace's taskspaces go in when `taskspace.namespaceDirs` is on, by
 * namespace ID.
 *
 * Two namespaces whose names give the same folder, such as "My ns" and "My-ns", or "Work"
 * and "work" on a case-insensitive disk, would otherwise share it. The oldest namespace
 * keeps the plain name and the others get their short ID added. IDs are UUIDv7, so the
 * oldest sorts first, and a namespace created later never moves an existing one's folder.
 *
 * Folders are worked out from the current namespaces each time, not stored. Renaming a
 * namespace, or deleting the older of two that clashed, changes the folder new taskspaces
 * go in. Directories made in the old folder stay on disk, but rename and delete from the
 * browser no longer touch them, see `isManagedTaskspaceDirectory`.
 */
export function namespaceFolders(namespaces: readonly NamespaceRef[]): Map<string, string> {
  const folders = new Map<string, string>();
  const taken = new Set<string>();
  const oldestFirst = [...namespaces].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const { id, name } of oldestFirst) {
    let folder = namespaceDirName(name, id);
    if (taken.has(folder.toLowerCase())) folder = `${folder}-${shortIdKey(id).slice(0, 7)}`;
    taken.add(folder.toLowerCase());
    folders.set(id, folder);
  }
  return folders;
}

type ParentOptions = {
  /** `taskspace.defaultDir` from the workspace config. */
  defaultDir: string;
  /** `taskspace.namespaceDirs` from the workspace config. */
  namespaceDirs: boolean;
  /** `taskspace.namespacePaths` from the workspace config. */
  namespacePaths: Record<string, string>;
  /** The namespace the new taskspace joins. */
  namespaceId: string;
  /** Every namespace, to tell whether a short key is ambiguous and to keep folders apart. */
  namespaces: readonly NamespaceRef[];
};

/**
 * The directory a new taskspace's own directory goes in, relative to the root or absolute.
 * Throw {@link AmbiguousNamespacePathError} when a `namespacePaths` key is ambiguous.
 */
export function taskspaceParentDir({
  defaultDir,
  namespaceDirs,
  namespacePaths,
  namespaceId,
  namespaces,
}: ParentOptions): string {
  const allIds = namespaces.map(({ id }) => id);
  const custom = namespacePathFor(namespacePaths, namespaceId, allIds);
  if (custom !== undefined) return custom;
  if (!namespaceDirs) return defaultDir;
  const folder = namespaceFolders(namespaces).get(namespaceId);
  if (folder === undefined) throw new Error(`Namespace not found: ${namespaceId}`);
  return join(defaultDir, folder);
}
