import {
  type Dirent,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TASKSPACE_DIR_ENTRIES_MAX, TASKSPACE_FILE_BYTES_MAX } from "../constants.js";
import type { TaskspaceEntry, TaskspaceEntryKind, TaskspaceListing } from "../types.js";
import { writeFileAtomic } from "./atomic-write.js";
import { fileSignature } from "./file-signature.js";

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

/** True when `child` is `parent` itself or sits underneath it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function mapFsError(e: unknown, whatIsMissing: string): TaskspaceFilesError {
  const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
  if (code === "EACCES" || code === "EPERM")
    return new TaskspaceFilesError("forbidden", "Permission denied");
  if (code === "ELOOP")
    return new TaskspaceFilesError("invalid-path", "Path resolves through a symlink loop");
  return new TaskspaceFilesError("not-found", whatIsMissing);
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
  // Check containment again after resolving symlinks.
  if (!isWithin(realBase, real))
    throw new TaskspaceFilesError("invalid-path", "Path must stay inside the taskspace");

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
  // Sorted before the cap so which entries survive it is the same on every read, and
  // stat'ed after it so a directory of a hundred thousand files costs a hundred thousand
  // syscalls fewer than it would the other way round.
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
  // Checked from the stat rather than from what came back, so an oversized file costs one
  // syscall instead of a read of however many megabytes it happens to be.
  if (stat.size > TASKSPACE_FILE_BYTES_MAX)
    throw new TaskspaceFilesError(
      "too-large",
      `File is larger than ${TASKSPACE_FILE_BYTES_MAX} bytes`,
    );
  return stat.size;
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

export type TaskspaceFile = {
  /** The file read, relative to the taskspace root and always `/`-separated. */
  path: string;
  content: string;
  /**
   * Identity of the bytes that were read, from {@link fileSignature}. Handed back on save
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
  statRegularFile(real);

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(real);
  } catch (e) {
    throw mapFsError(e, "File not found");
  }

  return {
    path: relative(base, real).split(sep).join("/"),
    content: decodeText(bytes),
    signature: fileSignature(real),
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

  // Check the current on-disk version immediately before writing.
  if (fileSignature(real) !== signature)
    throw new TaskspaceFilesError("stale", "File changed on disk since it was opened");

  try {
    writeFileAtomic(real, content);
  } catch (e) {
    throw mapFsError(e, "File not found");
  }

  return {
    path: relative(base, real).split(sep).join("/"),
    content,
    signature: fileSignature(real),
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
    const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
    if (code === "EEXIST") throw new TaskspaceFilesError("exists", "File already exists");
    throw mapFsError(e, "Directory not found");
  }

  return {
    path: relative(base, real).split(sep).join("/"),
    content: "",
    signature: fileSignature(real),
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
    const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
    if (code === "EEXIST") throw new TaskspaceFilesError("exists", "Directory already exists");
    throw mapFsError(e, "Directory not found");
  }

  return { path: relative(base, real).split(sep).join("/"), entries: [], truncated: false };
}
