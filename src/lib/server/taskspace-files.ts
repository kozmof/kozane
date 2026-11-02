import {
  type Dirent,
  type Stats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { TASKSPACE_DIR_ENTRIES_MAX, TASKSPACE_FILE_BYTES_MAX } from "../constants.js";
import type { TaskspaceEntry, TaskspaceEntryKind, TaskspaceListing } from "../types.js";
import { writeFileAtomic } from "./atomic-write.js";
import { fileSignature } from "./file-signature.js";
import { errorCode, isWithin } from "./fs-paths.js";
import { entryNameIssue } from "../entry-name.js";

export type TaskspaceFilesReason =
  | "invalid-path"
  | "not-found"
  | "forbidden"
  | "exists"
  | "too-large"
  | "not-text"
  | "stale";

/**
 * Map every file-error reason to an HTTP status shared by listing and file endpoints.
 * Exhaustive typing makes a missing mapping a compile error.
 */
export const TASKSPACE_FILES_STATUS: Record<TaskspaceFilesReason, number> = {
  "invalid-path": 400,
  forbidden: 403,
  "not-found": 404,
  // Creating never replaces an existing entry. Report a conflict when the name is already
  // taken.
  exists: 409,
  // Report a conflict if the file changed since the editor read it.
  stale: 409,
  "too-large": 413,
  "not-text": 415,
};

/**
 * Filesystem failure with a reason the route can map to an HTTP status. Keep this error
 * independent of SvelteKit.
 */
export class TaskspaceFilesError extends Error {
  constructor(
    readonly reason: TaskspaceFilesReason,
    message: string,
  ) {
    super(message);
    this.name = "TaskspaceFilesError";
  }
}

/**
 * True when a resolved path inside `realBase` passes through a dot-entry. Checking only the
 * requested segments would let a visible symlink such as `docs -> .secrets` reach a hidden
 * directory, so callers check the resolved path as well.
 */
function resolvesThroughDotEntry(realBase: string, real: string): boolean {
  const rel = relative(realBase, real);
  return rel !== "" && rel.split(sep).some((segment) => segment.startsWith("."));
}

/**
 * Translate filesystem errors with a client-facing meaning. Return any other error, such as
 * ENOSPC, EIO, or EROFS, unchanged so the route reports a server failure rather than a
 * missing file.
 */
function mapFsError(e: unknown, whatIsMissing: string): unknown {
  const code = errorCode(e);
  if (code === "EACCES" || code === "EPERM")
    return new TaskspaceFilesError("forbidden", "Permission denied");
  if (code === "ELOOP")
    return new TaskspaceFilesError("invalid-path", "Path resolves through a symlink loop");
  if (code === "ENAMETOOLONG") return new TaskspaceFilesError("invalid-path", "Path is too long");
  if (code === "ENOENT" || code === "ENOTDIR")
    return new TaskspaceFilesError("not-found", whatIsMissing);
  return e;
}

function entryKind(dirent: Dirent): TaskspaceEntryKind {
  // Check symlinks first so the listing describes the link itself.
  if (dirent.isSymbolicLink()) return "symlink";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  return "other";
}

function compareEntries(a: Dirent, b: Dirent): number {
  const aDir = !a.isSymbolicLink() && a.isDirectory();
  const bDir = !b.isSymbolicLink() && b.isDirectory();
  if (aDir !== bDir) return aDir ? -1 : 1;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  // Names differing only in case would otherwise order arbitrarily between runs.
  return byName !== 0 ? byName : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

type ListTaskspaceDirectory = {
  /** The taskspace root, already resolved from its database record. */
  baseDir: string;
  /** A `/`-separated path relative to `baseDir`. Empty lists the root itself. */
  subPath?: string;
};

/**
 * List a taskspace directory within the caller-supplied root. Check both the requested path
 * and resolved real path to prevent traversal through `..` or symlinks. Hide dot-prefixed
 * entries.
 */
export function listTaskspaceDirectory({
  baseDir,
  subPath = "",
}: ListTaskspaceDirectory): TaskspaceListing {
  let realBase: string;
  try {
    realBase = realpathSync(baseDir);
  } catch (e) {
    throw mapFsError(e, "Taskspace directory not found");
  }

  if (subPath.includes("\0"))
    throw new TaskspaceFilesError("invalid-path", "Path must not contain a NUL byte");
  const segments = subPath.split("/");
  const requested = resolve(realBase, segments.join(sep));
  if (!isWithin(realBase, requested))
    throw new TaskspaceFilesError("invalid-path", "Path must stay inside the taskspace");
  // Reject paths inside hidden entries as well as hiding them from listings. The containment
  // check already handles `.` and `..`.
  if (segments.some((segment) => segment.startsWith(".") && segment !== "." && segment !== ".."))
    throw new TaskspaceFilesError("invalid-path", "Dot-entries cannot be opened");

  let real: string;
  try {
    real = realpathSync(requested);
  } catch (e) {
    throw mapFsError(e, "Directory not found");
  }
  // Check containment and the dot-entry rule again after resolving symlinks.
  if (!isWithin(realBase, real))
    throw new TaskspaceFilesError("invalid-path", "Path must stay inside the taskspace");
  if (resolvesThroughDotEntry(realBase, real))
    throw new TaskspaceFilesError("invalid-path", "Dot-entries cannot be opened");

  let dirents: Dirent[];
  try {
    if (!lstatSync(real).isDirectory())
      throw new TaskspaceFilesError("invalid-path", "Not a directory");
    dirents = readdirSync(real, { withFileTypes: true });
  } catch (e) {
    if (e instanceof TaskspaceFilesError) throw e;
    throw mapFsError(e, "Directory not found");
  }

  const visible = dirents.filter((dirent) => !dirent.name.startsWith("."));
  const truncated = visible.length > TASKSPACE_DIR_ENTRIES_MAX;
  // Sort before limiting to return a consistent subset. Read metadata only for that subset
  // to avoid unnecessary filesystem calls in large directories.
  const kept = visible.sort(compareEntries).slice(0, TASKSPACE_DIR_ENTRIES_MAX);

  const entries: TaskspaceEntry[] = [];
  for (const dirent of kept) {
    const kind = entryKind(dirent);
    let stat;
    try {
      stat = lstatSync(resolve(real, dirent.name));
    } catch {
      continue; // Treat an entry deleted or made unreadable after listing as absent.
    }
    entries.push({
      name: dirent.name,
      kind,
      size: kind === "file" ? stat.size : null,
      modifiedAt: stat.mtime.toISOString(),
    });
  }

  return { path: relative(realBase, real).split(sep).join("/"), entries, truncated };
}

/**
 * Resolve an existing or prospective entry within a trusted taskspace root. Check lexical and
 * real-path containment, and reject dot-prefixed entries so hidden files cannot be accessed
 * by typing their names.
 */
function resolveTaskspaceEntry(baseDir: string, subPath: string): { real: string; base: string } {
  let realBase: string;
  try {
    realBase = realpathSync(baseDir);
  } catch (e) {
    throw mapFsError(e, "Taskspace directory not found");
  }

  // Reject NUL before path resolution so the route returns a file error with status 400
  // rather than an unexpected error with status 500.
  if (subPath.includes("\0"))
    throw new TaskspaceFilesError("invalid-path", "Path must not contain a NUL byte");

  const segments = subPath.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) throw new TaskspaceFilesError("invalid-path", "No file named");
  // Checked before the dot rule below, which would otherwise catch `..` too and answer a
  // traversal attempt with a message about dotfiles.
  if (segments.includes("..") || segments.includes("."))
    throw new TaskspaceFilesError("invalid-path", "Path must stay inside the taskspace");
  if (segments.some((segment) => segment.startsWith(".")))
    throw new TaskspaceFilesError("invalid-path", "Dot-entries cannot be opened");

  const requested = resolve(realBase, segments.join(sep));
  if (!isWithin(realBase, requested))
    throw new TaskspaceFilesError("invalid-path", "Path must stay inside the taskspace");

  // Resolve and check the parent directory even when the target file does not yet exist.
  // Check target existence separately with `lstat`.
  let realDir: string;
  try {
    realDir = realpathSync(dirname(requested));
  } catch (e) {
    throw mapFsError(e, "Directory not found");
  }
  if (!isWithin(realBase, realDir))
    throw new TaskspaceFilesError("invalid-path", "Path must stay inside the taskspace");
  if (resolvesThroughDotEntry(realBase, realDir))
    throw new TaskspaceFilesError("invalid-path", "Dot-entries cannot be opened");

  return { real: resolve(realDir, segments[segments.length - 1]), base: realBase };
}

/**
 * Validate that `real` is a regular file within the editor's size limit. Use `lstat` to
 * inspect and reject symlinks without following them.
 */
function statRegularFile(real: string): number {
  let stat;
  try {
    stat = lstatSync(real);
  } catch (e) {
    throw mapFsError(e, "File not found");
  }
  if (stat.isSymbolicLink())
    throw new TaskspaceFilesError("invalid-path", "Symbolic links cannot be opened");
  if (!stat.isFile()) throw new TaskspaceFilesError("invalid-path", "Not a regular file");
  // Check metadata before reading to avoid loading an oversized file into memory.
  if (stat.size > TASKSPACE_FILE_BYTES_MAX)
    throw new TaskspaceFilesError(
      "too-large",
      `File is larger than ${TASKSPACE_FILE_BYTES_MAX} bytes`,
    );
  return stat.size;
}

/**
 * Open flags for reading an editor file. `O_NOFOLLOW` refuses a symlink swapped in after
 * {@link statRegularFile} looked at the path, and `O_NONBLOCK` keeps a FIFO swapped in the
 * same way from blocking the server. Both are absent on Windows.
 */
const READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Read a regular file within the size limit. Check the path first for clear errors, then
 * open it once and check and read through that descriptor, so the file cannot be replaced
 * between the check and the read.
 */
function readRegularFile(real: string): Uint8Array {
  statRegularFile(real);
  let fd: number;
  try {
    fd = openSync(real, READ_FLAGS);
  } catch (e) {
    const code = errorCode(e);
    // With `O_NOFOLLOW`, ELOOP means the final entry became a symlink.
    if (code === "ELOOP")
      throw new TaskspaceFilesError("invalid-path", "Symbolic links cannot be opened");
    throw mapFsError(e, "File not found");
  }
  try {
    if (!fstatSync(fd).isFile())
      throw new TaskspaceFilesError("invalid-path", "Not a regular file");
    const bytes = readFileSync(fd);
    // Check what was read too, in case the file grew after the size check.
    if (bytes.length > TASKSPACE_FILE_BYTES_MAX)
      throw new TaskspaceFilesError(
        "too-large",
        `File is larger than ${TASKSPACE_FILE_BYTES_MAX} bytes`,
      );
    return bytes;
  } catch (e) {
    if (e instanceof TaskspaceFilesError) throw e;
    throw mapFsError(e, "File not found");
  } finally {
    closeSync(fd);
  }
}

/**
 * Decode strict UTF-8 and reject NUL-containing content before editing. Lenient decoding
 * could replace invalid bytes and corrupt the original on save.
 */
function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new TaskspaceFilesError("not-text", "File is not UTF-8 text");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TaskspaceFilesError("not-text", "File is not UTF-8 text");
  }
}

/**
 * Identify one version of an editor file by its metadata and its bytes. The metadata alone
 * misses a same-size write within one timestamp tick (see {@link fileSignature}), and a save
 * checked against it would overwrite that write. The hash closes that gap.
 */
function editorSignature(real: string, bytes: Uint8Array): string | null {
  const stat = fileSignature(real);
  return stat ? `${stat}:${createHash("sha1").update(bytes).digest("base64url")}` : null;
}

export type TaskspaceFile = {
  /** The file read, relative to the taskspace root and always `/`-separated. */
  path: string;
  content: string;
  /**
   * Identity of the bytes that were read, from {@link editorSignature}. Handed back on save
   * so a file changed underneath is refused rather than overwritten.
   */
  signature: string | null;
};

type TaskspaceFileTarget = {
  /** The taskspace root, already resolved from its database record. */
  baseDir: string;
  /** A `/`-separated path relative to `baseDir`. */
  subPath: string;
};

/**
 * Read one taskspace text file for the editor. {@link listTaskspaceDirectory} returns only
 * names and metadata.
 */
export function readTaskspaceFile({ baseDir, subPath }: TaskspaceFileTarget): TaskspaceFile {
  const { real, base } = resolveTaskspaceEntry(baseDir, subPath);
  const bytes = readRegularFile(real);

  return {
    path: relative(base, real).split(sep).join("/"),
    content: decodeText(bytes),
    signature: editorSignature(real, bytes),
  };
}

export type WriteTaskspaceFile = TaskspaceFileTarget & {
  content: string;
  /**
   * The signature the editor last read. A mismatch means the file changed on disk since
   * it was opened, and the write is refused rather than allowed to discard that change.
   */
  signature: string | null;
};

/**
 * Save validated text over an existing taskspace file after size and signature checks. Use
 * atomic replacement so readers do not see a partial write. File creation has a separate
 * empty-file operation.
 */
export function writeTaskspaceFile({
  baseDir,
  subPath,
  content,
  signature,
}: WriteTaskspaceFile): TaskspaceFile {
  const { real, base } = resolveTaskspaceEntry(baseDir, subPath);
  statRegularFile(real);

  if (content.includes("\0"))
    throw new TaskspaceFilesError("not-text", "Content is not UTF-8 text");
  if (Buffer.byteLength(content, "utf-8") > TASKSPACE_FILE_BYTES_MAX)
    throw new TaskspaceFilesError(
      "too-large",
      `Content is larger than ${TASKSPACE_FILE_BYTES_MAX} bytes`,
    );

  // Check the on-disk version immediately before writing to narrow the race window.
  // Another process can still write before the rename and have its change overwritten.
  // Node offers no compare-and-swap rename to prevent this.
  const current = readRegularFile(real);
  if (editorSignature(real, current) !== signature)
    throw new TaskspaceFilesError("stale", "File changed on disk since it was opened");

  try {
    writeFileAtomic(real, content);
  } catch (e) {
    throw mapFsError(e, "File not found");
  }

  return {
    path: relative(base, real).split(sep).join("/"),
    content,
    signature: editorSignature(real, Buffer.from(content, "utf-8")),
  };
}

/**
 * Reject occupied paths using `lstat`, including dangling symlinks. Creators also request
 * kernel-level exclusivity because another process can claim the name after this check.
 */
function assertNothingAt(real: string, what: string): void {
  try {
    lstatSync(real);
  } catch {
    return; // nothing there, which is the whole requirement
  }
  throw new TaskspaceFilesError("exists", `${what} already exists`);
}

/**
 * Create one empty file with exclusive `wx` access. Require an existing parent and apply the
 * shared taskspace path rules. Send all content through {@link writeTaskspaceFile} so first
 * and later saves use the same validation.
 */
export function createTaskspaceFile({ baseDir, subPath }: TaskspaceFileTarget): TaskspaceFile {
  const { real, base } = resolveTaskspaceEntry(baseDir, subPath);
  assertNothingAt(real, "File");

  try {
    writeFileSync(real, "", { flag: "wx" });
  } catch (e) {
    const code = errorCode(e);
    if (code === "EEXIST") throw new TaskspaceFilesError("exists", "File already exists");
    throw mapFsError(e, "Directory not found");
  }

  return {
    path: relative(base, real).split(sep).join("/"),
    content: "",
    signature: editorSignature(real, new Uint8Array()),
  };
}

/**
 * Create one directory and return its empty listing for the browser tree. Require an existing
 * parent and let exclusive `mkdir` reject a name taken concurrently.
 */
export function createTaskspaceDirectory({
  baseDir,
  subPath,
}: TaskspaceFileTarget): TaskspaceListing {
  const { real, base } = resolveTaskspaceEntry(baseDir, subPath);
  assertNothingAt(real, "Directory");

  try {
    mkdirSync(real);
  } catch (e) {
    const code = errorCode(e);
    if (code === "EEXIST") throw new TaskspaceFilesError("exists", "Directory already exists");
    throw mapFsError(e, "Directory not found");
  }

  return { path: relative(base, real).split(sep).join("/"), entries: [], truncated: false };
}

export type TaskspaceEntryChange = {
  /** The entry after the change, relative to the taskspace root and `/`-separated. */
  path: string;
  kind: TaskspaceEntryKind;
};

function kindOf(stat: Stats): TaskspaceEntryKind {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

/** Whether anything, even a dangling symlink, is at `real`. */
function existsAfter(real: string): boolean {
  try {
    lstatSync(real);
    return true;
  } catch {
    return false;
  }
}

function statEntry(real: string): Stats {
  try {
    return lstatSync(real);
  } catch (e) {
    throw mapFsError(e, "Entry not found");
  }
}

/**
 * Rename one entry within its directory. A symlink is renamed itself, never followed. Refuse
 * to replace an entry that exists when checked.
 *
 * Node has no rename that refuses to replace its target, so a file or empty directory that
 * another process creates under `name` between the check and the move is replaced. A
 * nonempty directory, or a mismatch between file and directory, makes the move fail instead.
 */
export function renameTaskspaceEntry({
  baseDir,
  subPath,
  name,
}: TaskspaceFileTarget & { name: string }): TaskspaceEntryChange {
  const issue = entryNameIssue(name);
  if (issue) throw new TaskspaceFilesError("invalid-path", issue);

  const { real, base } = resolveTaskspaceEntry(baseDir, subPath);
  const source = statEntry(real);
  const target = resolve(dirname(real), name);

  let existing: Stats | null;
  try {
    existing = lstatSync(target);
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw mapFsError(e, "Directory not found");
    existing = null;
  }
  if (existing) {
    // A case-only rename on a case-insensitive disk finds the entry itself.
    const sameEntry = existing.ino === source.ino && existing.dev === source.dev;
    // The same inode listed under its own name is a hard link, and `rename` between two
    // links to one file quietly does nothing.
    const otherLink =
      sameEntry && name !== basename(real) && readdirSync(dirname(real)).includes(name);
    if (!sameEntry || otherLink)
      throw new TaskspaceFilesError("exists", `"${name}" already exists`);
  }

  try {
    renameSync(real, target);
  } catch (e) {
    const code = errorCode(e);
    // Something took the name after the check above.
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR")
      throw new TaskspaceFilesError("exists", `"${name}" already exists`);
    if (code === "ENOTDIR" && existsAfter(target))
      throw new TaskspaceFilesError("exists", `"${name}" already exists`);
    throw mapFsError(e, "Entry not found");
  }
  return { path: relative(base, target).split(sep).join("/"), kind: kindOf(source) };
}

/**
 * Delete one entry. A directory goes with everything under it. Symlinks are removed
 * themselves, never followed, at the top and inside the tree. The taskspace root cannot be
 * named, so it is never removed here.
 */
export function deleteTaskspaceEntry({
  baseDir,
  subPath,
}: TaskspaceFileTarget): TaskspaceEntryChange {
  const { real, base } = resolveTaskspaceEntry(baseDir, subPath);
  const stat = statEntry(real);
  try {
    if (!stat.isSymbolicLink() && stat.isDirectory()) rmSync(real, { recursive: true });
    else unlinkSync(real);
  } catch (e) {
    throw mapFsError(e, "Entry not found");
  }
  return { path: relative(base, real).split(sep).join("/"), kind: kindOf(stat) };
}
