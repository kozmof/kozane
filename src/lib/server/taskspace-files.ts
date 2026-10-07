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
 * What each reason means over HTTP.
 *
 * Beside the reasons rather than in the routes because both the listing and the file
 * endpoints answer with it, and because being exhaustive is the point: a reason added to
 * the union without a code here is a compile error, rather than a route that quietly
 * answers `undefined` and turns a refusal into a 500.
 */
export const TASKSPACE_FILES_STATUS: Record<TaskspaceFilesReason, number> = {
  "invalid-path": 400,
  forbidden: 403,
  "not-found": 404,
  // Something is already at that name. A conflict rather than a bad request, for the same
  // reason `stale` is one: nothing about what was sent is wrong, and it is the state on
  // disk that refuses it. Creating never replaces what it finds.
  exists: 409,
  // The file changed on disk since the editor read it. A conflict rather than a bad
  // request: nothing about what was sent is wrong, only the version it was sent against.
  stale: 409,
  "too-large": 413,
  "not-text": 415,
};

/**
 * A listing that could not be produced, carrying why. The reason is what the route turns
 * into a status code; keeping it a plain class rather than SvelteKit's `error()` leaves
 * this module testable on its own, as the rest of `lib/server` is.
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
  // Checked first: `readdir` reports dirents without following links, so a symlink to a
  // directory answers true to both, and the link is what is actually there.
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
 * One directory of a taskspace, as the browser panel draws it.
 *
 * The boundary is `baseDir`, and it is enforced twice: once on the requested path, so a
 * `..` cannot walk out, and once on the resolved real path, so a symlink cannot either.
 * The caller supplies `baseDir` from the taskspace record — never from the request — so a
 * client can only ever choose where to look inside a taskspace, not which one.
 *
 * Dot-entries are skipped and never recursed into. That hides `.taskspace.json` and
 * `.git`, and keeps a stray `.env` from being announced to whoever has the page open.
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
  // The listing hides dot-entries, so it must not list inside one either: naming `.git`
  // outright would otherwise show what no listing offered, and what `readTaskspaceFile`
  // already refuses to open. `.` and `..` were settled by the containment check above.
  if (segments.some((segment) => segment.startsWith(".") && segment !== "." && segment !== ".."))
    throw new TaskspaceFilesError("invalid-path", "Dot-entries cannot be opened");

  let real: string;
  try {
    real = realpathSync(requested);
  } catch (e) {
    throw mapFsError(e, "Directory not found");
  }
  // The second boundary check. `requested` was inside the taskspace as spelled; this is
  // what it turned out to be once every link along the way was followed.
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
      continue; // deleted between the readdir and now, or unreadable — treat it as gone
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
 * The taskspace-relative path of one entry — a file or a directory, existing or not yet —
 * resolved and held inside the taskspace.
 *
 * The boundary is the same one {@link listTaskspaceDirectory} holds, and for the same
 * reason: the caller supplies `baseDir` from the taskspace record, and the request chooses
 * only where to look within it. It is checked twice — once on the path as spelled, so a
 * `..` cannot walk out, and once on what it turned out to be with every link followed.
 *
 * Dot-entries are refused rather than hidden. The listing skips them, so `.env` and
 * `.taskspace.json` are never announced to the panel; without the same rule here they
 * would still be readable by anyone who typed the name, and the tree hiding them would be
 * decoration rather than a boundary.
 */
function resolveTaskspaceEntry(baseDir: string, subPath: string): { real: string; base: string } {
  let realBase: string;
  try {
    realBase = realpathSync(baseDir);
  } catch (e) {
    throw mapFsError(e, "Taskspace directory not found");
  }

  // Refused before anything is resolved: `resolve()` throws a plain TypeError on a NUL, which
  // is not a TaskspaceFilesError and would reach the route as a 500 rather than a 400.
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

  // The directory is resolved rather than the file, so that a file which does not exist
  // yet still gets its containing directory checked. Whether the file itself is there is
  // `lstat`'s answer below, and it is a different one — "not found" rather than "outside".
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
 * `real` as an ordinary file of a size the editor will take on, or the reason it is not.
 *
 * `lstat` rather than `stat`: a symlink is reported as itself, so a link pointing out of
 * the taskspace is refused here rather than followed. The listing draws links as links and
 * does not open them, and this is the same rule at the other end.
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
 * Text as the editor holds it, or the reason these bytes are not text.
 *
 * Strict UTF-8, because the panel round-trips what it opens: bytes decoded leniently come
 * back as replacement characters, and saving would write that corruption to disk over the
 * original. A NUL is refused on the same grounds — it is the one byte that reliably says
 * "this was never text" — so the editor cannot be pointed at a binary and used to destroy
 * it.
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
 * One text file of a taskspace, as the editor opens it.
 *
 * The counterpart to {@link listTaskspaceDirectory}, and deliberately a separate function
 * from it: a listing carries names and metadata and nothing else, which is worth keeping
 * true of the code as well as of the answer.
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
 * Saves `content` over an existing text file of a taskspace.
 *
 * Only over an existing one. Creating is {@link createTaskspaceFile}, which makes an empty
 * file and nothing more, so that a save is always a save: this function decides what may
 * be written — the size cap, valid UTF-8, the signature check — and there is no second
 * path into a file that restates any of it.
 *
 * The write goes through {@link writeFileAtomic}, so a failure leaves the original intact
 * rather than truncated, and the rename it ends with makes the returned signature
 * reliably different from the one that came in.
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

  // Read immediately before the write rather than trusted from the open: the check is
  // against what is on disk now, which is the only version the save can actually clobber.
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
 * Refuses the path if anything is already there.
 *
 * `lstat` rather than `stat`, so a dangling symlink counts as occupied: creating over one
 * would follow it, and a link pointing out of the taskspace is exactly what the boundary
 * exists to refuse. The check is advisory — between it and the syscall that follows, the
 * name may be taken by something else — which is why both creators below ask the kernel
 * for exclusivity as well, and this is only here to answer with the reason rather than
 * with a bare `EEXIST`.
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
 * Creates one empty text file in a taskspace, for the editor to open on.
 *
 * Empty, and only ever empty. The panel creates a file and then saves into it through
 * {@link writeTaskspaceFile}, so the rules about what may be written — the size cap, valid
 * UTF-8, the signature check against what is on disk — are stated in one place and applied
 * to the first save as to every later one. A create that also carried content would be a
 * second, quieter way into the same file with its own copy of those rules.
 *
 * It never replaces anything. `wx` is what actually guarantees that: the existence check
 * above answers with a reason, but two requests racing for one name are separated by the
 * kernel, and the loser is refused rather than truncating the winner's file.
 *
 * The boundary is the one {@link readTaskspaceFile} holds — same resolver, so a `..`, a
 * symlinked directory along the way, and a dot-entry are refused here exactly as they are
 * there. A file whose parent directory does not exist is `not-found` rather than created:
 * creating the parents would let one request make a tree nobody has seen.
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
 * Creates one directory in a taskspace, and answers with it as the tree draws it.
 *
 * A {@link TaskspaceListing} rather than a bare acknowledgement, and the same shape
 * {@link listTaskspaceDirectory} returns, so the panel can put the new folder on screen
 * from the answer it already has. It is empty, necessarily — nothing else could be true of
 * a directory a moment after `mkdir`.
 *
 * Non-recursive. A parent that is not there is `not-found`, for the reason
 * {@link createTaskspaceFile} gives: one request should not be able to conjure a tree.
 * `mkdir` is itself exclusive, so as there, a race loses rather than quietly succeeding
 * against a name somebody else just took.
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
