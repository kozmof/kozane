import { describe, expect, it } from "vitest";
import { hyperlink } from "./hyperlink";

const ESC = "";

describe("hyperlink", () => {
  it("wraps the URL in an OSC 8 sequence on a TTY", () => {
    const result = hyperlink("http://localhost:5173", "Open", { isTTY: true, noColor: false });
    expect(result).toBe(`${ESC}]8;;http://localhost:5173${ESC}\\Open${ESC}]8;;${ESC}\\`);
  });

  it("defaults the label to the URL", () => {
    const url = "http://localhost:5173";
    expect(hyperlink(url, undefined, { isTTY: true, noColor: false })).toBe(
      `${ESC}]8;;${url}${ESC}\\${url}${ESC}]8;;${ESC}\\`,
    );
  });

  it("returns the plain label when not a TTY", () => {
    expect(hyperlink("http://localhost:5173", "Open", { isTTY: false, noColor: false })).toBe(
      "Open",
    );
  });

  it("returns the plain label when NO_COLOR is set", () => {
    expect(hyperlink("http://localhost:5173", "Open", { isTTY: true, noColor: true })).toBe("Open");
  });
});
