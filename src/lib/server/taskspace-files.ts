import { type Dirent, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TASKSPACE_DIR_ENTRIES_MAX, TASKSPACE_FILE_BYTES_MAX } from "../constants.js";
import type { TaskspaceEntry, TaskspaceEntryKind, TaskspaceListing } from "../types.js";
import { writeFileAtomic } from "./atomic-write.js";
import { fileSignature } from "./file-signature.js";

export type TaskspaceFilesReason =
  | "invalid-path"
  | "not-found"
  | "forbidden"
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

  const requested = resolve(realBase, subPath.split("/").join(sep));
  if (!isWithin(realBase, requested))
    throw new TaskspaceFilesError("invalid-path", "Path must stay inside the taskspace");

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
 * The taskspace-relative path of one file, resolved and held inside the taskspace.
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
function resolveTaskspaceFile(baseDir: string, subPath: string): { real: string; base: string } {
  let realBase: string;
  try {
    realBase = realpathSync(baseDir);
  } catch (e) {
    throw mapFsError(e, "Taskspace directory not found");
  }

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
  const { real, base } = resolveTaskspaceFile(baseDir, subPath);
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
 * Only over an existing one. There is no affordance in the panel for creating a file, and
 * an endpoint that writes to a path nobody has seen is a larger thing to hold inside a
 * boundary than one that writes back to a file the tree already listed.
 *
 * The write goes through {@link writeFileAtomic}, so a failure leaves the original intact
 * rather than truncated, and the rename it ends with is what makes the returned signature
 * reliably different from the one that came in.
 */
export function writeTaskspaceFile({
  baseDir,
  subPath,
  content,
  signature,
}: WriteTaskspaceFile): TaskspaceFile {
  const { real, base } = resolveTaskspaceFile(baseDir, subPath);
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
