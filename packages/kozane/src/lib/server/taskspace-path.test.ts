import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveTaskspacePath, storedLocation, taskspacePathIssue } from "./taskspace-path.js";

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

  it("refuses a relative path that leaves the workspace", () => {
    expect(resolveTaskspacePath("../elsewhere", "workspace_relative", "/work")).toBeNull();
    expect(resolveTaskspacePath("docs/../../x", "workspace_relative", "/work")).toBeNull();
  });

  it("refuses an absolute path stored as workspace-relative", () => {
    expect(resolveTaskspacePath("/etc", "workspace_relative", "/work")).toBeNull();
  });

  it("refuses a relative path stored as absolute", () => {
    expect(resolveTaskspacePath("docs", "absolute", "/work")).toBeNull();
  });
});

describe("taskspacePathIssue", () => {
  it("accepts names that only start with dots", () => {
    expect(taskspacePathIssue("..notes/a", "workspace_relative")).toBeNull();
    expect(taskspacePathIssue("docs/..", "workspace_relative")).toBeNull();
  });

  it("refuses an unknown path kind", () => {
    expect(taskspacePathIssue("docs", "remote")).toMatch(/unknown path kind/);
  });

  it("refuses a NUL byte", () => {
    expect(taskspacePathIssue("do\0cs", "workspace_relative")).toMatch(/NUL/);
  });
});

describe("storedLocation", () => {
  it("stores a path inside the root relative to it", () => {
    expect(storedLocation("/ws", "/ws/taskspaces/notes")).toEqual({
      pathKind: "workspace_relative",
      storedPath: join("taskspaces", "notes"),
    });
  });

  it("stores the root itself and a sibling sharing its prefix as absolute", () => {
    expect(storedLocation("/ws", "/ws")).toEqual({ pathKind: "absolute", storedPath: "/ws" });
    expect(storedLocation("/ws", "/ws-other/x")).toEqual({
      pathKind: "absolute",
      storedPath: "/ws-other/x",
    });
  });
});
