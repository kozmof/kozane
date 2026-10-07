import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SERVER_STATE_FILE = "server.json";

export type ServerState = {
  pid: number;
  startedAt: string;
  /**
   * Process identity beyond its PID. Older reservations omit this field and are checked by
   * PID alone.
   */
  startToken?: string;
  memory?: boolean;
  databaseUrl?: string;
};

export function serverStatePath(root: string): string {
  return join(root, ".kozane", SERVER_STATE_FILE);
}

/**
 * Read a process start-time token from Linux `/proc`, or return null when unavailable.
 * Combine it with the PID to detect stale reservations after PID reuse. Other platforms rely
 * on PID liveness alone.
 */
function processStartToken(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `comm` is parenthesised and may itself hold spaces or parentheses, so the fields are
    // counted from after its closing bracket rather than by splitting the whole line.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // After removing `pid` and `comm`, field 22 (`starttime`) is at index 19.
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** The `startToken` field for a reservation, or nothing at all where none can be read. */
function startTokenOf(pid: number): { startToken?: string } {
  const startToken = processStartToken(pid);
  return startToken === null ? {} : { startToken };
}

/**
 * Check whether a PID still belongs to the reserving process. Preserve the reservation if
 * either start-time token is unknown. Only different known tokens establish PID reuse.
 */
export function isSameProcess(reserved: string | undefined, current: string | null): boolean {
  if (reserved === undefined || current === null) return true;
  return reserved === current;
}

function processIsRunning(pid: number, startToken?: string): boolean {
  let alive: boolean;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    alive = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return alive && isSameProcess(startToken, processStartToken(pid));
}

export function activeServerProcess(root: string): ServerState | null {
  const path = serverStatePath(root);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerState>;
    if (
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.startedAt !== "string" ||
      (value.startToken !== undefined && typeof value.startToken !== "string") ||
      (value.memory !== undefined && typeof value.memory !== "boolean") ||
      (value.databaseUrl !== undefined && typeof value.databaseUrl !== "string")
    ) {
      return null;
    }
    if (processIsRunning(value.pid!, value.startToken)) return value as ServerState;
  } catch {
    return null;
  }
  try {
    unlinkSync(path);
  } catch {
    /* another process may have replaced it */
  }
  return null;
}

export function writeServerState(
  root: string,
  pid = process.pid,
  details: Pick<ServerState, "memory" | "databaseUrl"> = {},
): void {
  const path = serverStatePath(root);
  writeFileSync(
    path,
    JSON.stringify({
      pid,
      startedAt: new Date().toISOString(),
      ...startTokenOf(pid),
      ...details,
    }) + "\n",
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

/** Atomically reserves a workspace for one server process. */
export function claimServerState(
  root: string,
  pid = process.pid,
  details: Pick<ServerState, "memory" | "databaseUrl"> = {},
): ServerState | null {
  const path = serverStatePath(root);
  const value: ServerState = {
    pid,
    startedAt: new Date().toISOString(),
    ...startTokenOf(pid),
    ...details,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let previousContents: string | null = null;
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(value) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        previousContents = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const active = activeServerProcess(root);
      if (active) {
        if (active.pid === pid) return null;
        return active;
      }
      // activeServerProcess removes a well-formed stale file itself. Remove a
      // malformed/partial file only if nobody replaced it while we inspected it.
      try {
        if (existsSync(path) && readFileSync(path, "utf8") === previousContents) unlinkSync(path);
      } catch {
        // Another process changed the reservation; retry the exclusive create.
      }
    }
  }

  throw new Error(`Unable to reserve Kozane server state at ${path}`);
}

export function removeServerState(root: string, pid = process.pid): void {
  const state = activeServerProcess(root);
  if (state?.pid !== pid) return;
  try {
    unlinkSync(serverStatePath(root));
  } catch {
    /* already removed */
  }
}
