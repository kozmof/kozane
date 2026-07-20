import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SERVER_STATE_FILE = "server.json";

type ServerState = { pid: number; startedAt: string };

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
      typeof value.startedAt !== "string"
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

export function writeServerState(root: string, pid = process.pid): void {
  const path = serverStatePath(root);
  writeFileSync(path, JSON.stringify({ pid, startedAt: new Date().toISOString() }) + "\n", {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
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
