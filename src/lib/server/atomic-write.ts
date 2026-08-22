import {
  chmodSync,
  closeSync,
  fsyncSync,
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
  /** Permissions for the finished file. Omitted leaves it to the umask, as a plain write would. */
  mode?: number;
};

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
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${temporaryCounter++}`;
  let fd: number | undefined;
  try {
    fd = mode === undefined ? openSync(temporary, "wx") : openSync(temporary, "wx", mode);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    // The open above is subject to the umask, so the mode a caller asked for is only
    // guaranteed once it has been set outright.
    if (mode !== undefined) chmodSync(target, mode);
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
