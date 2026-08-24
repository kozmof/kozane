import { describe, it, expect } from "vitest";
import {
  clamp,
  chunked,
  contentLimitIssue,
  CANVAS_W,
  CANVAS_H,
  CONTENT_MAX,
  INSERT_CHUNK_MAX,
  INSERT_PARAMS_MAX,
} from "./constants.js";
import { DEFAULT_UI_CONFIG, UI_NUM_RANGES } from "./ui-config.js";

describe("clamp", () => {
  it("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps to lo when below range", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it("clamps to hi when above range", () => {
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it("returns lo when value equals lo", () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });

  it("returns hi when value equals hi", () => {
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("clamps canvas X position", () => {
    expect(clamp(-50, 0, CANVAS_W)).toBe(0);
    expect(clamp(CANVAS_W + 100, 0, CANVAS_W)).toBe(CANVAS_W);
    expect(clamp(1400, 0, CANVAS_W)).toBe(1400);
  });

  it("clamps canvas Y position", () => {
    expect(clamp(-50, 0, CANVAS_H)).toBe(0);
    expect(clamp(CANVAS_H + 100, 0, CANVAS_H)).toBe(CANVAS_H);
    expect(clamp(1000, 0, CANVAS_H)).toBe(1000);
  });
});

describe("UI config", () => {
  it("uses a 5% zoom step by default and defines its override range", () => {
    expect(DEFAULT_UI_CONFIG.zoomStep).toBe(0.05);
    expect(UI_NUM_RANGES.zoomStep).toEqual([0.01, 1]);
  });
});

describe("contentLimitIssue", () => {
  it("passes text at the limit", () => {
    expect(contentLimitIssue("x".repeat(CONTENT_MAX), CONTENT_MAX)).toBeNull();
  });

  it("passes empty text — emptiness is the caller's own check", () => {
    expect(contentLimitIssue("", CONTENT_MAX)).toBeNull();
  });

  it("reports text one character past the limit, naming it", () => {
    const issue = contentLimitIssue("x".repeat(CONTENT_MAX + 1), CONTENT_MAX);
    expect(issue).toBe(`content must be a string under ${CONTENT_MAX} characters`);
  });

  // The limit is the workspace's `ui.contentMax`, not the built-in default, so the
  // message has to name whichever one the caller passed.
  it("holds text to a raised limit and says so", () => {
    expect(contentLimitIssue("x".repeat(CONTENT_MAX + 1), 20_000)).toBeNull();
    expect(contentLimitIssue("x".repeat(20_001), 20_000)).toBe(
      "content must be a string under 20000 characters",
    );
  });

  it("holds text to a lowered limit and says so", () => {
    expect(contentLimitIssue("x".repeat(500), 200)).toBe(
      "content must be a string under 200 characters",
    );
  });
});

describe("chunked", () => {
  it("returns nothing for an empty list", () => {
    expect(chunked([])).toEqual([]);
  });

  it("keeps a list shorter than the chunk size whole", () => {
    expect(chunked([1, 2, 3], { size: 5 })).toEqual([[1, 2, 3]]);
  });

  it("splits an exact multiple without a trailing empty chunk", () => {
    expect(chunked([1, 2, 3, 4], { size: 2 })).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("puts the remainder in a final short chunk", () => {
    expect(chunked([1, 2, 3, 4, 5], { size: 2 })).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("defaults to INSERT_CHUNK_MAX", () => {
    const rows = Array.from({ length: INSERT_CHUNK_MAX + 1 }, (_, i) => i);
    const chunks = chunked(rows);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(INSERT_CHUNK_MAX);
    expect(chunks[1]).toHaveLength(1);
  });

  it("preserves order across the split", () => {
    expect(chunked([1, 2, 3, 4, 5], { size: 2 }).flat()).toEqual([1, 2, 3, 4, 5]);
  });

  it("narrows the batch when a row is too wide for the parameter budget", () => {
    const columnsPerRow = INSERT_PARAMS_MAX / 50; // 50 rows' worth of parameters
    const rows = Array.from({ length: 120 }, (_, i) => i);
    const chunks = chunked(rows, { columnsPerRow });
    expect(chunks[0]).toHaveLength(50);
    expect(chunks.flat()).toEqual(rows);
    for (const chunk of chunks)
      expect(chunk.length * columnsPerRow).toBeLessThanOrEqual(INSERT_PARAMS_MAX);
  });

  it("keeps the row count as the ceiling for a narrow row", () => {
    const rows = Array.from({ length: INSERT_CHUNK_MAX + 1 }, (_, i) => i);
    // Two columns affords far more than INSERT_CHUNK_MAX rows, so the row count still wins.
    expect(chunked(rows, { columnsPerRow: 2 })[0]).toHaveLength(INSERT_CHUNK_MAX);
  });

  it("never yields an empty batch, however wide the row", () => {
    const chunks = chunked([1, 2, 3], { columnsPerRow: INSERT_PARAMS_MAX * 10 });
    expect(chunks).toEqual([[1], [2], [3]]);
  });
});

describe("constants", () => {
  it("CANVAS_W is 5600", () => {
    expect(CANVAS_W).toBe(5600);
  });

  it("CANVAS_H is 4000", () => {
    expect(CANVAS_H).toBe(4000);
  });

  it("CONTENT_MAX is 10000", () => {
    expect(CONTENT_MAX).toBe(10_000);
  });
});
