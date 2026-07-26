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
  memory?: boolean;
  databaseUrl?: string;
};

export function serverStatePath(root: string): string {
  return join(root, ".kozane", SERVER_STATE_FILE);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
      (value.memory !== undefined && typeof value.memory !== "boolean") ||
      (value.databaseUrl !== undefined && typeof value.databaseUrl !== "string")
    ) {
      return null;
    }
    if (processIsRunning(value.pid!)) return value as ServerState;
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
    JSON.stringify({ pid, startedAt: new Date().toISOString(), ...details }) + "\n",
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
  const value: ServerState = { pid, startedAt: new Date().toISOString(), ...details };

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
