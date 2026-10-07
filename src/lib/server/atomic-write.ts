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
 * Count temporary files within this process to distinguish writes in the same millisecond.
 * The PID and timestamp alone can produce duplicate names and make exclusive creation fail.
 */
let temporaryCounter = 0;

type WriteFileAtomicOptions = {
  /**
   * Permissions for the replacement file. When omitted, preserve an existing regular file's
   * mode or use the umask for a new file.
   */
  mode?: number;
};

/**
 * Read the target's permissions before replacing its inode so saves preserve executable and
 * other permission bits.
 *
 * Preserve modes only for regular files. Symlinks and device nodes are replaced, so their
 * modes do not describe the new file.
 */
function existingMode(target: string): number | undefined {
  try {
    const stat = lstatSync(target);
    // Keep only permission bits. The mode also contains file-type bits.
    return stat.isFile() ? stat.mode & 0o7777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a temporary file, flush it, and rename it over the target so readers never see a
 * partial write. Flush the directory to persist the rename.
 *
 * Replacement also changes the inode, allowing {@link fileSignature} to detect same-size
 * writes within one timestamp tick.
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
