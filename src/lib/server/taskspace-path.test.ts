import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveTaskspacePath } from "./taskspace-path.js";

describe("resolveTaskspacePath", () => {
  it("joins a workspace-relative path to the workspace root", () => {
    expect(resolveTaskspacePath("docs/notes", "workspace_relative", "/work")).toBe(
      join("/work", "docs/notes"),
    );
  });

  it("returns an absolute path unchanged", () => {
    expect(resolveTaskspacePath("/elsewhere/notes", "absolute", "/work")).toBe("/elsewhere/notes");
  });

  it("resolves an empty relative path to the workspace root itself", () => {
    expect(resolveTaskspacePath("", "workspace_relative", "/work")).toBe(join("/work", ""));
  });
});
