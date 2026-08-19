import { type Dirent, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TASKSPACE_DIR_ENTRIES_MAX } from "../constants.js";
import type { TaskspaceEntry, TaskspaceEntryKind, TaskspaceListing } from "../types.js";

export type TaskspaceFilesReason = "invalid-path" | "not-found" | "forbidden";

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
