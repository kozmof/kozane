import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeServerProcess,
  removeServerState,
  claimServerState,
  isSameProcess,
  serverStatePath,
  writeServerState,
} from "./runtime-state";
import { commandDbUrl, dbUrl } from "../../cli/lib/config";

const roots: string[] = [];
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-runtime-"));
  roots.push(root);
  mkdirSync(join(root, ".kozane"));
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Whether this platform lets a process read its own start time; see `isSameProcess`. */
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

  it("exposes the active memory database to CLI commands", () => {
    const root = workspace();
    const memoryUrl = "file:/tmp/kozane-memory-test/kozane.db";
    writeServerState(root, process.pid, { memory: true, databaseUrl: memoryUrl });

    expect(activeServerProcess(root)).toMatchObject({
      pid: process.pid,
      memory: true,
      databaseUrl: memoryUrl,
    });
    expect(commandDbUrl(root)).toBe(memoryUrl);

    removeServerState(root);
    expect(commandDbUrl(root)).toBe(dbUrl(root));
  });

  it("removes stale process state", () => {
    const root = workspace();
    writeFileSync(
      serverStatePath(root),
      JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString() }),
    );
    expect(activeServerProcess(root)).toBeNull();
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
    // Present wherever the start time is readable, absent where it is not; either way the
    // reservation belongs to this process and has to survive being read back.
    if (reserved?.startToken !== undefined) expect(reserved.startToken).toEqual(expect.any(String));
  });

  it("treats a recycled pid as stale rather than as the server that reserved it", () => {
    const root = workspace();
    // This process is alive and holds the pid, but it is not the process that wrote this
    // reservation — which is what a pid handed out again after a hard kill looks like.
    writeFileSync(
      serverStatePath(root),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        startToken: "not-the-token-of-this-process",
      }),
    );

    // Only decidable where the start time can be read. Where it cannot, the pid check
    // stands alone and the reservation is correctly left in place — `isSameProcess` below
    // is where that rule is pinned down.
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
