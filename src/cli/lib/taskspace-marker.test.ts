import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  TASKSPACE_MARKER_KIND,
  TASKSPACE_MARKER_VERSION,
  TASKSPACE_MARKER_VERSION_1,
} from "../../lib/taskspace-marker.js";
import { readTaskspaceMarker } from "./taskspace-marker.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(): { dir: string; markerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "kozane-marker-test-"));
  dirs.push(dir);
  const markerPath = join(dir, ".taskspace.json");
  writeFileSync(
    markerPath,
    JSON.stringify({
      kind: TASKSPACE_MARKER_KIND,
      version: TASKSPACE_MARKER_VERSION,
      taskspaceId: "taskspace-1",
      namespaceId: "p-1",
    }),
  );
  return { dir, markerPath };
}

describe("readTaskspaceMarker", () => {
  it("auto-detects a marker in the current directory only", () => {
    const { dir } = fixture();
    expect(readTaskspaceMarker(undefined, dir)?.marker.taskspaceId).toBe("taskspace-1");
    const child = join(dir, "child");
    mkdirSync(child);
    expect(readTaskspaceMarker(undefined, child)).toBeNull();
  });

  it("accepts an explicit directory or marker path", () => {
    const { dir, markerPath } = fixture();
    expect(readTaskspaceMarker(dir)?.marker.taskspaceId).toBe("taskspace-1");
    expect(readTaskspaceMarker(markerPath)?.marker.taskspaceId).toBe("taskspace-1");
  });

  it("rejects missing and invalid explicit markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "kozane-marker-test-"));
    dirs.push(dir);
    expect(() => readTaskspaceMarker(dir)).toThrow("Taskspace marker not found");
    writeFileSync(join(dir, ".taskspace.json"), "not json");
    expect(() => readTaskspaceMarker(dir)).toThrow("Invalid taskspace marker");
  });

  // Every marker written before the rename is one of these, so the message it gets is the
  // whole of what a user has to go on — "Invalid taskspace marker" would describe a
  // well-formed file as broken and leave them looking for the corruption.
  it("names the rename when refusing a marker written before it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kozane-marker-test-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, ".taskspace.json"),
      JSON.stringify({
        kind: TASKSPACE_MARKER_KIND,
        version: TASKSPACE_MARKER_VERSION_1,
        taskspaceId: "taskspace-1",
        projectId: "p-1",
      }),
    );

    expect(() => readTaskspaceMarker(dir)).toThrow(/predates the rename/);
    expect(() => readTaskspaceMarker(dir)).toThrow(/kozane taskspace create/);
  });
});
