import { join } from "node:path";
import { MIN_SHORT_ID_LENGTH, compactId, idMatches, shortIdKey } from "../short-id-key.js";
import type { TaskspacePlacement } from "../taskspace-config.js";

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

/** Longest folder name, in characters as the user sees them, to keep paths readable. */
const MAX_DIR_NAME_LENGTH = 60;

/**
 * Longest folder name, in UTF-8 bytes. Most file systems allow 255 bytes per name. This leaves
 * room for the `-` a reserved name gets and for the longest suffix `namespaceFolders` adds, a
 * `-` and the 32-digit full ID: 255 - 1 - 33.
 */
const MAX_DIR_NAME_BYTES = 221;

const utf8 = new TextEncoder();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The leading characters of `text` within both limits. Characters are counted as the user
 * sees them, so an emoji made of several code points or a letter with a combining accent is
 * kept whole or dropped whole.
 */
function capName(text: string): string {
  let bytes = 0;
  let out = "";
  let count = 0;
  for (const { segment: char } of graphemes.segment(text)) {
    if (++count > MAX_DIR_NAME_LENGTH) break;
    bytes += utf8.encode(char).length;
    if (bytes > MAX_DIR_NAME_BYTES) break;
    out += char;
  }
  return out;
}

/**
 * Turn a namespace name into one plain folder name. The name is put in Unicode NFC form,
 * so the same name typed on macOS and Linux gives the same folder. Characters that are not
 * allowed in folder names on common systems become `-`, and so does each run of whitespace
 * inside the name. Leading dots are dropped so the folder is not hidden, and trailing dots
 * and spaces are dropped because Windows strips them. Long names are cut to
 * {@link MAX_DIR_NAME_LENGTH} characters and {@link MAX_DIR_NAME_BYTES} bytes. Use
 * `fallback`, such as the namespace ID, when nothing usable is left.
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
  const short = stripEnds(capName(cleaned));
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
    const plain = namespaceDirName(name, id);
    const key = shortIdKey(id);
    let folder = plain;
    // Lengthen the suffix while it still clashes, such as with a namespace literally named
    // `<name>-<hex>`. The full ID is the last resort.
    for (let length = MIN_SHORT_ID_LENGTH; taken.has(folder.toLowerCase()); length++)
      folder =
        length <= key.length ? `${plain}-${key.slice(0, length)}` : `${plain}-${compactId(id)}`;
    taken.add(folder.toLowerCase());
    folders.set(id, folder);
  }
  return folders;
}

/** The workspace's `taskspace` placement settings, plus the namespace being placed. */
type ParentOptions = TaskspacePlacement & {
  /** The namespace the new taskspace joins. */
  namespaceId: string;
  /** Every namespace, to tell whether a short key is ambiguous and to keep folders apart. */
  namespaces: readonly NamespaceRef[];
  /**
   * `namespaceFolders(namespaces)`, when the caller already has it, such as when placing
   * many taskspaces at once.
   */
  folders?: ReadonlyMap<string, string>;
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
  folders,
}: ParentOptions): string {
  const allIds = namespaces.map(({ id }) => id);
  const custom = namespacePathFor(namespacePaths, namespaceId, allIds);
  if (custom !== undefined) return custom;
  if (!namespaceDirs) return defaultDir;
  const folder = (folders ?? namespaceFolders(namespaces)).get(namespaceId);
  if (folder === undefined) throw new Error(`Namespace not found: ${namespaceId}`);
  return join(defaultDir, folder);
}
