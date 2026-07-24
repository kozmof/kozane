import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeServerState } from "../../lib/server/runtime-state";
import { openingStatus } from "./opening-status";

const roots: string[] = [];
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-opening-status-"));
  roots.push(root);
  mkdirSync(join(root, ".kozane"));
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("openingStatus", () => {
  it("reports a stopped server", () => {
    expect(openingStatus(workspace())).toBe("stopped");
  });

  it("reports a persistent server", () => {
    const root = workspace();
    writeServerState(root);
    expect(openingStatus(root)).toBe("running (persistent)");
  });

  it("reports a memory server", () => {
    const root = workspace();
    writeServerState(root, process.pid, { memory: true, databaseUrl: "file:/tmp/memory.db" });
    expect(openingStatus(root)).toBe("running (:memory:)");
  });
});
