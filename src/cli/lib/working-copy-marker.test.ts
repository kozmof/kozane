import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WC_MARKER_KIND, WC_MARKER_VERSION } from "../../lib/wc-marker.js";
import { readWorkingCopyMarker } from "./working-copy-marker.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(): { dir: string; markerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "kozane-marker-test-"));
  dirs.push(dir);
  const markerPath = join(dir, ".working-copy.json");
  writeFileSync(
    markerPath,
    JSON.stringify({
      kind: WC_MARKER_KIND,
      version: WC_MARKER_VERSION,
      workingCopyId: "wc-1",
      projectId: "p-1",
    }),
  );
  return { dir, markerPath };
}

describe("readWorkingCopyMarker", () => {
  it("auto-detects a marker in the current directory only", () => {
    const { dir } = fixture();
    expect(readWorkingCopyMarker(undefined, dir)?.marker.workingCopyId).toBe("wc-1");
    const child = join(dir, "child");
    mkdirSync(child);
    expect(readWorkingCopyMarker(undefined, child)).toBeNull();
  });

  it("accepts an explicit directory or marker path", () => {
    const { dir, markerPath } = fixture();
    expect(readWorkingCopyMarker(dir)?.marker.workingCopyId).toBe("wc-1");
    expect(readWorkingCopyMarker(markerPath)?.marker.workingCopyId).toBe("wc-1");
  });

  it("rejects missing and invalid explicit markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "kozane-marker-test-"));
    dirs.push(dir);
    expect(() => readWorkingCopyMarker(dir)).toThrow("Working-copy marker not found");
    writeFileSync(join(dir, ".working-copy.json"), "not json");
    expect(() => readWorkingCopyMarker(dir)).toThrow("Invalid working-copy marker");
  });
});
