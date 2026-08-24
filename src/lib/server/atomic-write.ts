import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Counts temporary files made within one process, so two writes to the same target cannot
 * pick the same name. The pid and the clock alone do not separate them: back-to-back
 * writes land in the same millisecond, and the second `openSync(…, "wx")` would then fail
 * on the first one's leftover rather than replacing the target.
 */
let temporaryCounter = 0;

type WriteFileAtomicOptions = {
  /**
   * Permissions for the finished file. Omitted keeps whatever the file being replaced had,
   * and falls back to the umask only where there is no such file — see {@link existingMode}.
   */
  mode?: number;
};

/**
 * The permissions of the file about to be replaced, or nothing where there is none to keep.
 *
 * This exists because the rename below gives the target a new inode, which is the whole
 * point of the write and also its one side effect: the new file carries the mode it was
 * created with rather than the mode of the thing it stands in for. A caller that named no
 * mode means "leave this file as it was", not "reset it to the umask" — without this, a
 * shell script saved through the taskspace editor comes back stripped of the bit that made
 * it executable, and nothing reports it.
 *
 * `lstat`, and regular files only: a symlink or a device node is *replaced* by this write
 * rather than rewritten, so its bits describe something that will not be there afterwards.
 */
function existingMode(target: string): number | undefined {
  try {
    const stat = lstatSync(target);
    // Masked to the permission bits — `mode` also carries the file type, which `open` and
    // `chmod` would refuse.
    return stat.isFile() ? stat.mode & 0o7777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes a file by filling a temporary and renaming it over the target, so nothing ever
 * reads a half-written one after a crash or a full disk.
 *
 * The rename is also what makes the write *visible*: it gives the target a new inode, and
 * {@link fileSignature} — which decides whether a cached parse is still good — leans on
 * that. A plain in-place write keeps the inode, leaving only mtime and size to tell the
 * versions apart, and two writes of the same length inside one filesystem timestamp tick
 * have neither. A caller that rewrites a file quickly would then go on serving what it
 * parsed the first time.
 *
 * `fsync` on the file makes the contents durable before the rename, and `fsync` on the
 * directory makes the rename itself durable; without the second, a crash can leave the
 * directory entry pointing at nothing.
 */
export function writeFileAtomic(
  target: string,
  contents: string,
  { mode }: WriteFileAtomicOptions = {},
): void {
  const finalMode = mode ?? existingMode(target);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${temporaryCounter++}`;
  let fd: number | undefined;
  try {
    fd = finalMode === undefined ? openSync(temporary, "wx") : openSync(temporary, "wx", finalMode);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    // The open above is subject to the umask, so the mode is only guaranteed once it has
    // been set outright.
    if (finalMode !== undefined) chmodSync(target, finalMode);
    const directoryFd = openSync(dirname(target), "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}
