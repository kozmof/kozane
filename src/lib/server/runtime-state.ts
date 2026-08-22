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
   * Identity of the process behind `pid`, beyond the number itself. Optional: a
   * reservation written before this field existed simply has none, and is judged by pid
   * alone as it was before.
   */
  startToken?: string;
  memory?: boolean;
  databaseUrl?: string;
};

export function serverStatePath(root: string): string {
  return join(root, ".kozane", SERVER_STATE_FILE);
}

/**
 * When the process behind `pid` started, as the kernel counts it, or null where that
 * cannot be read.
 *
 * A pid on its own is not an identity. They are recycled, so a server killed hard enough
 * to leave its reservation behind — `SIGKILL`, a power cut — hands the workspace to
 * whatever process is next given that number, and Kozane would go on reporting the
 * workspace as served by a process that has nothing to do with it. The start time settles
 * it: the pid may come round again, but not with the same start time.
 *
 * Linux only, via `/proc`. Elsewhere this returns null and the pid check stands alone,
 * which is what the whole file did before — a `ps` subprocess per liveness check is a
 * price this is not worth.
 */
function processStartToken(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `comm` is parenthesised and may itself hold spaces or parentheses, so the fields are
    // counted from after its closing bracket rather than by splitting the whole line.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // `starttime` is field 22 of the record; dropping `pid` and `comm` puts it at 19 here.
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
 * Whether the process now holding a pid is the one that reserved it.
 *
 * Split out from the `/proc` read above and exported because the two fail in different
 * ways and only one of them is a decision. Reading a start time is a capability — Linux
 * has it, other platforms do not, and a hardened container may withhold it — while this is
 * the rule that says what a workspace does with the answer, and it is the rule that
 * decides whether a workspace can be recovered after a hard kill.
 *
 * Both unknowns resolve in favour of the reservation standing: a reservation written
 * before this field existed carries no token, and a token that cannot be read now is not
 * evidence of anything. Only two tokens that disagree mean the pid has been handed on.
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
