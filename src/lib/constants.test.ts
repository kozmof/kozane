import { describe, it, expect } from "vitest";
import { clamp, CANVAS_W, CANVAS_H, CONTENT_MAX } from "./constants.js";

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

describe("constants", () => {
  it("CANVAS_W is 2800", () => {
    expect(CANVAS_W).toBe(2800);
  });

  it("CANVAS_H is 2000", () => {
    expect(CANVAS_H).toBe(2000);
  });

  it("CONTENT_MAX is 10000", () => {
    expect(CONTENT_MAX).toBe(10_000);
  });
});
