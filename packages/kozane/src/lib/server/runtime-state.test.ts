import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileDbUrl } from "../db-url";
import {
  MEMORY_DIR_PREFIX,
  activeServerProcess,
  removeServerState,
  claimServerState,
  isSameProcess,
  serverStatePath,
  writeServerState,
} from "./runtime-state";

const roots: string[] = [];
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-runtime-"));
  roots.push(root);
  mkdirSync(join(root, ".kozane"));
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Whether this platform exposes the current process's start time. See `isSameProcess`. */
function startTimeReadable(): boolean {
  try {
    readFileSync(`/proc/${process.pid}/stat`, "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("server runtime state", () => {
  it("records and removes the current server process", () => {
    const root = workspace();
    writeServerState(root);
    expect(activeServerProcess(root)?.pid).toBe(process.pid);
    expect(readFileSync(serverStatePath(root), "utf8")).toContain(String(process.pid));
    removeServerState(root);
    expect(activeServerProcess(root)).toBeNull();
  });

  it("atomically rejects a second server process", () => {
    const root = workspace();
    expect(claimServerState(root, process.pid)).toBeNull();
    expect(claimServerState(root, process.pid)).toBeNull();

    const otherRoot = workspace();
    writeFileSync(
      serverStatePath(otherRoot),
      JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }),
    );
    expect(claimServerState(otherRoot, process.pid)?.pid).toBe(1);
  });

  it("recovers a partial stale reservation", () => {
    const root = workspace();
    writeFileSync(serverStatePath(root), "{");

    expect(claimServerState(root)).toBeNull();
    expect(activeServerProcess(root)?.pid).toBe(process.pid);
  });

  // Verify stored state for a memory server. `commandDbUrl` tests separately verify how CLI
  // commands read it.
  it("exposes the active memory database", () => {
    const root = workspace();
    const memoryUrl = "file:/tmp/kozane-memory-test/kozane.db";
    writeServerState(root, process.pid, { memory: true, databaseUrl: memoryUrl });

    expect(activeServerProcess(root)).toMatchObject({
      pid: process.pid,
      memory: true,
      databaseUrl: memoryUrl,
    });

    removeServerState(root);
    expect(activeServerProcess(root)).toBeNull();
  });

  it("removes stale process state", () => {
    const root = workspace();
    writeFileSync(
      serverStatePath(root),
      JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString() }),
    );
    expect(activeServerProcess(root)).toBeNull();
  });

  it("deletes the temporary database of a memory server that was killed", () => {
    const root = workspace();
    const memoryDir = mkdtempSync(join(tmpdir(), MEMORY_DIR_PREFIX));
    roots.push(memoryDir);
    writeFileSync(join(memoryDir, "kozane.db"), "");
    writeFileSync(
      serverStatePath(root),
      JSON.stringify({
        pid: 2147483647,
        startedAt: new Date().toISOString(),
        memory: true,
        databaseUrl: fileDbUrl(join(memoryDir, "kozane.db")),
      }),
    );
    expect(activeServerProcess(root)).toBeNull();
    expect(existsSync(memoryDir)).toBe(false);
  });

  it("keeps the temporary database of a memory server that is still running", () => {
    const root = workspace();
    const memoryDir = mkdtempSync(join(tmpdir(), MEMORY_DIR_PREFIX));
    roots.push(memoryDir);
    writeServerState(root, process.pid, {
      memory: true,
      databaseUrl: fileDbUrl(join(memoryDir, "kozane.db")),
    });
    expect(activeServerProcess(root)?.pid).toBe(process.pid);
    expect(existsSync(memoryDir)).toBe(true);
  });

  it("deletes nothing a stale reservation names outside a memory directory", () => {
    const root = workspace();
    // A hand-edited reservation pointing at the workspace's own database.
    const keep = join(root, ".kozane");
    writeFileSync(join(keep, "kozane.db"), "");
    writeFileSync(
      serverStatePath(root),
      JSON.stringify({
        pid: 2147483647,
        startedAt: new Date().toISOString(),
        memory: true,
        databaseUrl: fileDbUrl(join(keep, "kozane.db")),
      }),
    );
    expect(activeServerProcess(root)).toBeNull();
    expect(existsSync(join(keep, "kozane.db"))).toBe(true);
  });

  it("still trusts a reservation written before start tokens existed", () => {
    const root = workspace();
    writeFileSync(
      serverStatePath(root),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    expect(activeServerProcess(root)?.pid).toBe(process.pid);
  });

  it("keeps a reservation whose start token still matches", () => {
    const root = workspace();
    writeServerState(root);
    const reserved = activeServerProcess(root);
    expect(reserved?.pid).toBe(process.pid);
    // Preserve the reservation whether or not this platform provides a start-time token.
    if (reserved?.startToken !== undefined) expect(reserved.startToken).toEqual(expect.any(String));
  });

  it("treats a recycled pid as stale rather than as the server that reserved it", () => {
    const root = workspace();
    // Model PID reuse by giving the current PID a different recorded start time.
    writeFileSync(
      serverStatePath(root),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        startToken: "not-the-token-of-this-process",
      }),
    );

    // Require a readable start time to identify PID reuse. Otherwise preserve the reservation
    // based on the PID check.
    if (!startTimeReadable()) {
      expect(activeServerProcess(root)?.pid).toBe(process.pid);
      return;
    }
    expect(activeServerProcess(root)).toBeNull();
    // And the reservation is now available to take.
    expect(claimServerState(root, process.pid)).toBeNull();
  });
});

describe("isSameProcess", () => {
  it("holds the reservation when it carries no token", () => {
    expect(isSameProcess(undefined, "5150")).toBe(true);
    expect(isSameProcess(undefined, null)).toBe(true);
  });

  it("holds the reservation when the start time cannot be read now", () => {
    expect(isSameProcess("5150", null)).toBe(true);
  });

  it("holds the reservation when the tokens agree", () => {
    expect(isSameProcess("5150", "5150")).toBe(true);
  });

  it("releases it when the tokens disagree — the pid was handed on", () => {
    expect(isSameProcess("5150", "9021")).toBe(false);
  });
});
