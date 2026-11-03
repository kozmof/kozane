import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { namespaceDirName, taskspaceParentDir } from "./taskspace-location.js";
import { isManagedTaskspaceDirectory } from "./taskspace-directory.js";

describe("namespaceDirName", () => {
  it("keeps an ordinary name", () => {
    expect(namespaceDirName("Project", "id")).toBe("Project");
    expect(namespaceDirName("日本語", "id")).toBe("日本語");
  });

  it("turns each run of spaces into one dash", () => {
    expect(namespaceDirName("My Project", "id")).toBe("My-Project");
    expect(namespaceDirName("  a   b  ", "id")).toBe("a-b");
    expect(namespaceDirName("全角　スペース", "id")).toBe("全角-スペース");
  });

  it("replaces characters that are not allowed in folder names", () => {
    expect(namespaceDirName("a/b\\c", "id")).toBe("a-b-c");
    expect(namespaceDirName('x:y*z?"<>|', "id")).toBe("x-y-z-----");
    expect(namespaceDirName("tab\there", "id")).toBe("tab-here");
  });

  it("drops leading dots and trailing dots and spaces", () => {
    expect(namespaceDirName(".hidden", "id")).toBe("hidden");
    expect(namespaceDirName("name. . ", "id")).toBe("name");
  });

  it("falls back when nothing usable is left", () => {
    expect(namespaceDirName("..", "the-id")).toBe("the-id");
    expect(namespaceDirName("   ", "the-id")).toBe("the-id");
  });

  it("avoids names Windows reserves", () => {
    expect(namespaceDirName("CON", "id")).toBe("CON-");
    expect(namespaceDirName("lpt1", "id")).toBe("lpt1-");
  });
});

describe("taskspaceParentDir", () => {
  const namespace = { id: "ns-1", name: "Work" };

  it("adds the namespace folder when namespaceDirs is on", () => {
    expect(taskspaceParentDir({ defaultDir: "taskspaces", namespaceDirs: true, namespace })).toBe(
      join("taskspaces", "Work"),
    );
  });

  it("uses defaultDir alone when namespaceDirs is off", () => {
    expect(taskspaceParentDir({ defaultDir: "taskspaces", namespaceDirs: false, namespace })).toBe(
      "taskspaces",
    );
  });
});

describe("isManagedTaskspaceDirectory", () => {
  const check = (storedPath: string) =>
    isManagedTaskspaceDirectory({
      workspaceRoot: "/work",
      storedPath,
      pathKind: "workspace_relative",
      defaultDir: "taskspaces",
    });

  it("accepts a directory directly in defaultDir or in a namespace folder there", () => {
    expect(check(join("taskspaces", "notes"))).toBe(true);
    expect(check(join("taskspaces", "Work", "notes"))).toBe(true);
  });

  it("rejects a directory elsewhere or nested deeper", () => {
    expect(check(join("src", "notes"))).toBe(false);
    expect(check(join("taskspaces", "Work", "deep", "notes"))).toBe(false);
  });
});
