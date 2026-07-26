import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeServerProcess,
  removeServerState,
  claimServerState,
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
});
